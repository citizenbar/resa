-- =====================================================================
-- UPLOAD PHOTO SANS CODE : quota par IP (septembre 2026)
-- =====================================================================
-- À exécuter APRÈS rc-rules-2026-09.sql et op-photo-2026-09.sql. Rejouable.
--
-- POURQUOI CE FICHIER EXISTE
--
-- Sur le module Events, l'upload de fichier est adossé au CODE DJ : la RPC
-- ev_can_upload vérifie que le code existe, n'est pas scellé, et décompte un
-- crédit (5 maximum). Le code est donc à la fois l'authentification et le
-- compteur anti-abus.
--
-- Radio Campus et Open Platine n'ont pas de code : leurs formulaires sont
-- ouverts à tout visiteur. Étendre l'upload à ces modules sans garde
-- reviendrait à offrir un dépôt de fichiers anonyme et illimité sur le bucket.
--
-- LA PARADE : un quota par ADRESSE IP, décompté côté serveur dans la même
-- transaction que la signature. La Vercel Function lit l'IP dans
-- x-forwarded-for et appelle upload_quota_take() AVANT de signer quoi que ce
-- soit. Pas de crédit disponible -> pas de signature.
--
-- DIMENSIONNEMENT ASSUMÉ : quelques utilisateurs simultanés au maximum, jamais
-- plus. Le quota est donc calibré pour être invisible à un usage normal (un
-- intervenant téléverse une photo, éventuellement deux ou trois essais s'il se
-- trompe de fichier) et bloquant pour une boucle automatisée.
--
--   10 uploads par IP et par heure.
--
-- Un formulaire rempli honnêtement en consomme 1. Il faudrait s'y reprendre à
-- dix fois dans la même heure pour être gêné, ce qui n'arrive pas.
--
-- POURQUOI L'IP ET PAS UNE SESSION
--   Le visiteur est anonyme par construction (aucun compte, aucun code). L'IP
--   est le seul identifiant stable dont on dispose. Elle est imparfaite (un
--   partage de connexion mutualise le quota, un attaquant déterminé change
--   d'IP), mais l'objectif n'est pas de rendre l'abus impossible : c'est de le
--   rendre inintéressant à l'échelle d'un bar. La vraie barrière de volume
--   reste file_size_limit (5 Mo) et allowed_mime_types côté bucket.
--
-- CONFIDENTIALITÉ : on ne stocke PAS l'IP en clair, mais son empreinte SHA-256
--   salée par le jour courant. Deux conséquences voulues : la table ne
--   constitue pas un registre d'adresses exploitable, et l'empreinte change
--   chaque jour, ce qui purge naturellement le lien avec la personne. Le
--   compteur reste correct : la fenêtre est d'une heure, très inférieure au
--   jour.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Le compteur
-- ---------------------------------------------------------------------
create table if not exists upload_quota (
  ip_hash    text        not null,
  window_start timestamptz not null,
  n          int         not null default 0,
  primary key (ip_hash, window_start)
);

-- RLS active SANS aucune policy : la table est invisible et non modifiable
-- pour anon comme pour authenticated. Seule la RPC en security definer y
-- touche. Même motif que admin_emails (restrict-admin-emails.sql).
alter table upload_quota enable row level security;
revoke all on table upload_quota from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. upload_quota_take() : consomme un crédit, ou refuse
-- ---------------------------------------------------------------------
-- Renvoie true si l'appelant peut uploader (et décompte), false sinon.
-- Atomique : l'insert ... on conflict do update sérialise les appels
-- concurrents sur la même clé, il n'y a pas de course entre deux requêtes.
-- search_path inclut `extensions` : sur Supabase, pgcrypto (qui fournit
-- digest()) est installé dans ce schéma et NON dans public. Sans lui, la
-- fonction échoue à l'exécution avec « function digest(text, unknown) does not
-- exist » — une erreur qui n'apparaît pas sur un Postgres local où l'extension
-- atterrit dans public.
create or replace function upload_quota_take(p_ip text, p_max int default 10)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash   text;
  v_window timestamptz;
  v_n      int;
begin
  if p_ip is null or length(trim(p_ip)) = 0 then
    return false;                       -- pas d'IP identifiable : on refuse
  end if;

  -- Empreinte salée par le jour : pas d'adresse en clair, rotation quotidienne.
  v_hash   := encode(digest(trim(p_ip) || ':' || current_date::text, 'sha256'), 'hex');
  v_window := date_trunc('hour', now());

  insert into upload_quota(ip_hash, window_start, n)
       values (v_hash, v_window, 1)
  on conflict (ip_hash, window_start)
    do update set n = upload_quota.n + 1
  returning n into v_n;

  -- Ménage opportuniste : on profite de l'appel pour effacer les fenêtres
  -- anciennes. Évite d'avoir à planifier un job pour une table de ce volume.
  delete from upload_quota where window_start < now() - interval '24 hours';

  return v_n <= p_max;
end $$;

-- pgcrypto fournit digest(). Sur Supabase il est déjà installé dans le schéma
-- `extensions` (cf. search_path ci-dessus). On le crée seulement s'il manque
-- vraiment, en le plaçant au même endroit pour rester cohérent.
create extension if not exists pgcrypto with schema extensions;

-- Droits : révoquer PUBLIC d'abord (piège n°3 de MIGRATIONS.md). La fonction
-- est appelée par la Vercel Function avec la clé anon.
revoke all on function upload_quota_take(text,int) from public;
grant execute on function upload_quota_take(text,int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. La purge des orphelins doit connaître les photos RC et OP
-- ---------------------------------------------------------------------
-- purge_orphan_artist_photos() ne regardait que ev_slots.photo. Depuis que
-- Radio Campus et Open Platine ont une photo, une image parfaitement
-- référencée par rc_reservations.photo ou op_slots.photo serait considérée
-- comme orpheline et SUPPRIMÉE au bout de 24h. On étend donc la condition
-- aux trois tables.
create or replace function purge_orphan_artist_photos()
returns int
language plpgsql security definer set search_path = public, storage as $$
declare v_deleted int;
begin
  with orphans as (
    select o.id, o.name
      from storage.objects o
     where o.bucket_id = 'artist-photos'
       and o.created_at < now() - interval '24 hours'
       and not exists (
         select 1 from ev_slots s
          where s.photo is not null and s.photo like '%/' || o.name
       )
       and not exists (
         select 1 from rc_reservations r
          where r.photo is not null and r.photo like '%/' || o.name
       )
       and not exists (
         select 1 from op_slots p
          where p.photo is not null and p.photo like '%/' || o.name
       )
  )
  delete from storage.objects o using orphans x where o.id = x.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function purge_orphan_artist_photos() from public;
revoke all on function purge_orphan_artist_photos() from anon;
revoke all on function purge_orphan_artist_photos() from authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   -- le quota se consomme et finit par refuser :
--   select upload_quota_take('203.0.113.7', 3);   -- true  (1/3)
--   select upload_quota_take('203.0.113.7', 3);   -- true  (2/3)
--   select upload_quota_take('203.0.113.7', 3);   -- true  (3/3)
--   select upload_quota_take('203.0.113.7', 3);   -- false <— plafond atteint
--   select upload_quota_take('203.0.113.8', 3);   -- true  (autre IP, non affectée)
--
--   -- aucune adresse en clair n'est stockée :
--   select ip_hash, window_start, n from upload_quota;
--
--   -- anon ne voit pas la table :
--   set role anon;
--     select * from upload_quota;      -- doit ÉCHOUER (permission denied)
--     select upload_quota_take('1.2.3.4');  -- doit MARCHER (c'est la RPC)
--   reset role;
--
--   -- nettoyage des lignes de test :
--   delete from upload_quota;
-- =====================================================================
