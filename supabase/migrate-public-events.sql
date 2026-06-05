-- =====================================================================
-- MIGRATION — enrichissement du flux public (endpoint agent-readable)
-- =====================================================================
-- À exécuter UNE FOIS dans le SQL Editor de Supabase, APRÈS schema.sql +
-- policies.sql + fix-grants.sql + fix-column-leak.sql. Rejouable.
--
-- OBJECTIF : exposer aux agents (flux /events.yaml et /events.json) les
-- liens promo publics que les intervenants renseignent déjà : instagram,
-- soundcloud, photo, plus le format. Sans JAMAIS exposer les contacts
-- privés (email, tel, remarques) ni les notes internes (micros, materiel)
-- ni le code Events.
--
-- DÉCISION PRODUIT : instagram / soundcloud / photo sont de la donnée de
-- PROMOTION (faite pour être diffusée), pas du contact. On les sort donc
-- des tables *_contacts (privées, admin only) vers les tables *_slots
-- (vitrine), et on étend les grants colonne pour qu'anon puisse les lire
-- sur les lignes validées. email / tel / remarques restent dans *_contacts.
--
-- Validé sur Postgres jetable : fuite (code/micros/materiel) toujours fermée,
-- vue enrichie lisible par anon sur les seules lignes validées, contacts
-- privés inaccessibles, lien promo d'une ligne pending NON exposé.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Colonnes promo PUBLIQUES sur les tables vitrine *_slots.
-- ---------------------------------------------------------------------
alter table op_slots        add column if not exists instagram  text;
alter table rc_reservations add column if not exists instagram  text;
alter table rc_reservations add column if not exists photo      text;
alter table ev_slots        add column if not exists instagram  text;
alter table ev_slots        add column if not exists soundcloud text;
alter table ev_slots        add column if not exists photo      text;

-- ---------------------------------------------------------------------
-- 2) Migrer les liens existants depuis *_contacts -> *_slots.
--    UNIQUEMENT les lignes validées ET à venir (event_date >= aujourd'hui).
--    Pourquoi le filtre date : un UPDATE d'une ligne dont la date est déjà
--    passée déclenche la revérification du CHECK *_not_past (event_date >=
--    current_date) sur cette ligne, qui échoue. Or le flux public ne montre
--    que le futur : l'instagram d'un event passé n'a aucune utilité. On ne
--    migre donc que les lignes à venir.
-- ---------------------------------------------------------------------
update op_slots s set instagram = c.instagram
  from op_contacts c
 where c.slot_id = s.id and s.status = 'validated' and s.event_date >= current_date;
update ev_slots s set instagram = c.instagram, soundcloud = c.soundcloud, photo = c.photo
  from ev_contacts c
 where c.slot_id = s.id and s.status = 'validated' and s.event_date >= current_date;

-- ---------------------------------------------------------------------
-- 3) Retirer les liens promo des tables *_contacts : la source unique
--    devient *_slots (évite la divergence entre deux copies).
-- ---------------------------------------------------------------------
alter table op_contacts drop column if exists instagram;
alter table ev_contacts drop column if exists instagram;
alter table ev_contacts drop column if exists soundcloud;
alter table ev_contacts drop column if exists photo;

-- ---------------------------------------------------------------------
-- 4) Étendre les grants COLONNE d'anon aux nouvelles colonnes promo.
--    Sans ça, la vue public_events (security_invoker=on, donc exécutée
--    avec les droits d'anon) ne pourrait pas lire instagram/photo/etc.
--    On n'expose QUE ces colonnes : code/micros/materiel restent fermés.
-- ---------------------------------------------------------------------
grant select (instagram)                      on op_slots        to anon;
grant select (instagram, photo)               on rc_reservations to anon;
grant select (instagram, soundcloud, photo)   on ev_slots        to anon;

-- ---------------------------------------------------------------------
-- 5) Vue public_events : agenda enrichi, validés uniquement, pas de PII.
--    security_invoker=on : la vue applique les RLS du rôle appelant, donc
--    anon ne voit que ce qu'il a le droit de voir (double filet avec le
--    where status='validated' interne).
-- ---------------------------------------------------------------------
create or replace view public_events as
  select id, 'op'::text as module, event_date,
         lpad((debut_min/60 % 24)::text,2,'0')||':'||lpad((debut_min % 60)::text,2,'0') as heure,
         debut_min as sort_min, dj_nom as titre, styles as sous_titre,
         styles, null::text as format, instagram, null::text as soundcloud, null::text as photo
    from op_slots where status = 'validated'
  union all
  select id, 'rc', event_date, '19:00', 19*60,
         emission, animateur || coalesce(' · ' || style, ''),
         style, null, instagram, null, photo
    from rc_reservations where status = 'validated'
  union all
  select id, 'ev', event_date,
         coalesce(to_char(debut,'HH24:MI'), '21:30'),
         coalesce(extract(hour from debut)::int, 21) * 60 + coalesce(extract(minute from debut)::int, 30),
         soiree, dj_nom || coalesce(' · ' || styles, ''),
         styles, format, instagram, soundcloud, photo
    from ev_slots where status = 'validated';

alter view public_events set (security_invoker = on);
grant select on public_events to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6) RPC d'écriture réécrites : les liens promo vont désormais dans
--    *_slots (et non plus dans *_contacts, dont les colonnes ont été
--    supprimées à l'étape 3). email/tel/remarques restent dans *_contacts.
-- ---------------------------------------------------------------------
create or replace function op_request(
  p_date date, p_debut_min int, p_duree_min int, p_dj_nom text, p_styles text,
  p_email text, p_tel text, p_instagram text, p_remarques text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into op_slots(event_date, debut_min, duree_min, dj_nom, styles, instagram, status)
    values (p_date, p_debut_min, p_duree_min, p_dj_nom, p_styles, p_instagram, 'pending')
    returning id into v_id;
  insert into op_contacts(slot_id, email, tel, remarques)
    values (v_id, p_email, p_tel, p_remarques);
  return v_id;
exception when exclusion_violation then raise exception 'overlap' using errcode = 'P0001';
end $$;

create or replace function ev_fill_slot(
  p_code text, p_dj_nom text, p_debut time, p_fin time, p_styles text, p_format text,
  p_email text, p_tel text, p_instagram text, p_soundcloud text, p_photo text, p_remarques text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from ev_slots where code = p_code and code_used = false for update;
  if v_id is null then raise exception 'code_used' using errcode = 'P0001'; end if;
  update ev_slots
    set code_used = true, dj_nom = p_dj_nom, debut = p_debut, fin = p_fin,
        styles = p_styles, format = p_format,
        instagram = p_instagram, soundcloud = p_soundcloud, photo = p_photo, status = 'pending'
    where id = v_id;
  insert into ev_contacts(slot_id, email, tel, remarques)
    values (v_id, p_email, p_tel, p_remarques)
    on conflict (slot_id) do update set
      email = excluded.email, tel = excluded.tel, remarques = excluded.remarques;
  return v_id;
end $$;

-- Droits d'exécution (revoke public avant grant, règle du projet).
revoke all on function op_request(date,int,int,text,text,text,text,text,text) from public;
grant execute on function op_request(date,int,int,text,text,text,text,text,text) to anon, authenticated;
revoke all on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) from public;
grant execute on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) to anon, authenticated;

-- =====================================================================
-- VÉRIFICATION (SQL Editor) :
--   set role anon;
--     select * from public_events;            -- doit MARCHER, avec instagram/photo
--     select code from ev_slots;              -- doit ÉCHOUER (toujours fermé)
--     select instagram from ev_slots;         -- doit MARCHER (colonne promo)
--   reset role;
-- =====================================================================
