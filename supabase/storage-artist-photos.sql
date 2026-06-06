-- =====================================================================
-- STORAGE — bucket "artist-photos" (visuels d'artistes, module Events)
-- =====================================================================
-- À exécuter dans le SQL Editor de Supabase. Crée le bucket et les policies.
--
-- MODÈLE :
--   - Bucket PUBLIC en lecture : les visuels sont destinés à être diffusés
--     (com de l'asso, flux agent). L'URL publique est donc lisible sans auth.
--   - Noms de fichiers en UUID (posés par la Vercel Function) : non devinables
--     et non énumérables (aucune policy SELECT large, donc pas de listing).
--   - ÉCRITURE : personne en direct. anon ne peut PAS uploader. L'upload passe
--     par une signed upload URL générée côté serveur (Vercel Function avec la
--     clé secrète sb_secret_), après vérification du code Events. La signed URL
--     court-circuite les policies (elle est signée par la clé secrète), donc on
--     n'ouvre AUCUNE policy INSERT à anon : la surface d'abus reste fermée.
-- =====================================================================

-- Bucket public (lecture par URL directe), créé de façon idempotente.
-- file_size_limit + allowed_mime_types sont la SEULE barrière appliquée côté
-- SERVEUR Storage, y compris sur les uploads via signed URL (le fichier ne
-- transite pas par notre fonction, donc la validation client est contournable :
-- ces deux contraintes ferment XSS-stocké et uploads géants au bon endroit).
-- Le "do update" DOIT couvrir ces colonnes, sinon un bucket déjà créé sans
-- contrainte resterait non protégé.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artist-photos', 'artist-photos', true, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- LECTURE PUBLIQUE : autoriser SELECT (download par URL) sur ce bucket.
-- Un bucket "public=true" sert déjà les objets par URL ; cette policy rend
-- l'intention explicite et compatible avec security. On NE crée PAS de policy
-- de listing (pas de SELECT large permettant d'énumérer les noms).
-- ---------------------------------------------------------------------
drop policy if exists "artist_photos_public_read" on storage.objects;
create policy "artist_photos_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'artist-photos');

-- ---------------------------------------------------------------------
-- AUCUNE policy INSERT/UPDATE/DELETE pour anon ni authenticated :
--   - les uploads passent par signed upload URL (clé secrète serveur), qui
--     n'est pas soumise aux policies ;
--   - la gestion (suppression, remplacement) se fait via la clé secrète aussi
--     (admin / fonction serveur), jamais depuis le navigateur.
-- Résultat : impossible pour un visiteur de déposer un fichier directement.
-- =====================================================================

-- =====================================================================
-- ANTI-ABUS (finding C1) : plafonner le nombre d'uploads par code Events.
-- =====================================================================
-- Problème : ev_claim_code ne CONSOMME pas le code (le scellage se fait au
-- fillSlot). Un code valide permettait donc de signer une INFINITÉ d'uploads
-- -> spam du Storage. On ajoute un compteur par slot et une RPC atomique qui
-- valide ET incrémente, refusant au-delà d'une petite limite.
alter table ev_slots add column if not exists upload_count int not null default 0;

-- ev_can_upload : true si le code existe, n'est pas scellé, et n'a pas dépassé
-- la limite ; incrémente le compteur dans la même transaction (FOR UPDATE =
-- pas de course entre deux requêtes concurrentes sur le même code).
create or replace function ev_can_upload(p_code text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int;
begin
  select id, upload_count into v_id, v_n
    from ev_slots
   where code = p_code and code_used = false
   for update;
  if v_id is null then return false; end if;     -- code inconnu ou déjà scellé
  if v_n >= 5 then return false; end if;          -- max 5 uploads par code
  update ev_slots set upload_count = upload_count + 1 where id = v_id;
  return true;
end $$;

-- Droits (règle projet : revoke public AVANT grant explicite).
revoke all on function ev_can_upload(text) from public;
revoke all on function ev_can_upload(text) from anon;
grant execute on function ev_can_upload(text) to anon, authenticated;

-- NB : upload_count n'est PAS exposé à anon en lecture directe (la policy
-- ev_sel_validated + les column-grants de fix-column-leak.sql ne l'incluent
-- pas ; anon ne lit ev_slots qu'en colonnes vitrine). Rien à ajouter.

-- =====================================================================
-- PURGE DES PHOTOS ORPHELINES (finding M2)
-- =====================================================================
-- La photo est uploadée AVANT le scellage de la fiche (ev_fill_slot). Si le DJ
-- abandonne, ou si un upload est fait sans finaliser, le fichier reste dans le
-- bucket sans être référencé. La photo "valide" est celle dont l'URL publique
-- figure dans ev_slots.photo (c'est là que ev_fill_slot l'écrit).
--
-- Fonction de purge : supprime du bucket les objets créés il y a plus de 24h
-- dont le NOM (clé de l'objet) n'apparaît dans AUCUN ev_slots.photo.
-- La suppression dans storage.objects retire le fichier (Supabase gère le blob).
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
         -- une photo est référencée si son nom de fichier termine l'URL stockée
         select 1 from ev_slots s
          where s.photo is not null and s.photo like '%/' || o.name
       )
  )
  delete from storage.objects o using orphans x where o.id = x.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function purge_orphan_artist_photos() from public;
revoke all on function purge_orphan_artist_photos() from anon;
revoke all on function purge_orphan_artist_photos() from authenticated;
-- Réservée au planificateur / admin (service_role). Personne d'autre ne l'exécute.

-- PLANIFICATION (à faire une fois dans Supabase, optionnel mais recommandé) :
--   Dashboard -> Database -> Extensions -> activer "pg_cron", puis :
--     select cron.schedule('purge-artist-photos','0 4 * * *',
--                          $$ select purge_orphan_artist_photos(); $$);
--   (purge quotidienne à 4h). À défaut de pg_cron, appeler manuellement la
--   fonction de temps en temps, ou via un Vercel Cron qui tape une petite
--   route protégée. Le volume restant borné par C1 (max 5 uploads/code), la
--   purge est un confort, pas une urgence.
