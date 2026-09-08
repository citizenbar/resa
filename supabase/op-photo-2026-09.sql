-- =====================================================================
-- OPEN PLATINE — ajout du champ photo (septembre 2026)
-- =====================================================================
-- À exécuter dans le SQL Editor de Supabase, APRÈS rc-rules-2026-08.sql.
-- Rejouable sans dommage.
--
-- POURQUOI : Open Platine est le seul module sans photo. ev_slots et
-- rc_reservations en ont une (colonne promo publique, publiée dans
-- /events.json) ; op_slots n'a jamais reçu la sienne. Résultat : impossible
-- de faire une affiche pour un DJ d'Open Platine sans aller lui redemander
-- son visuel à la main.
--
-- CE FICHIER NE CHANGE AUCUNE RÈGLE MÉTIER. Les mercredis, la fenêtre
-- 19h30-02h00, les durées 1h-4h et l'anti-chevauchement restent identiques.
--
-- ORDRE : ce SQL D'ABORD, le front ENSUITE. p_photo a une valeur par défaut,
-- donc l'ancien front continue de fonctionner entre les deux.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. La colonne, et sa lecture publique
-- ---------------------------------------------------------------------
-- Même modèle que ev_slots et rc_reservations : la photo est une donnée de
-- PROMOTION, publique par nature, posée sur la table vitrine et non dans
-- op_contacts (qui reste réservée aux coordonnées).
alter table op_slots add column if not exists photo text;

grant select (photo) on op_slots to anon;

-- ---------------------------------------------------------------------
-- 2. Vue public_events — la photo Open Platine sort enfin dans le flux
-- ---------------------------------------------------------------------
-- Cette définition est l'ÉTAT FINAL des trois modules : elle inclut aussi
-- les correctifs Radio Campus de rc-rules-2026-08.sql (plus d'animateur ni
-- de style publiés). La rejouer après ce fichier-là ne défait donc rien.
create or replace view public_events as
  select id, 'op'::text as module, event_date,
         lpad((debut_min/60 % 24)::text,2,'0')||':'||lpad((debut_min % 60)::text,2,'0') as heure,
         debut_min as sort_min, dj_nom as titre, styles as sous_titre,
         styles, null::text as format, instagram, null::text as soundcloud,
         photo                                  -- <— la photo Open Platine
    from op_slots where status = 'validated'
  union all
  select id, 'rc', event_date, '19:00', 19*60,
         emission, null::text,           -- sous_titre : pas d'animateur (cf. rc-rules)
         null::text,                     -- styles : fermé aussi
         null, null::text, null, photo
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
-- 3. op_request v2 — accepte p_photo
-- ---------------------------------------------------------------------
-- La signature passe de 9 à 10 arguments : un "create or replace" créerait
-- une SURCHARGE au lieu de remplacer. On drop explicitement l'ancienne.
drop function if exists op_request(date,int,int,text,text,text,text,text,text);

create or replace function op_request(
  p_date date, p_debut_min int, p_duree_min int, p_dj_nom text, p_styles text,
  p_email text, p_tel text, p_instagram text, p_remarques text,
  -- Valeur par défaut : l'ancien front (9 arguments) continue de fonctionner
  -- entre l'exécution de ce SQL et le déploiement du nouveau front.
  p_photo text default ''
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into op_slots(event_date, debut_min, duree_min, dj_nom, styles, instagram, photo, status)
    values (p_date, p_debut_min, p_duree_min, p_dj_nom, p_styles, p_instagram, p_photo, 'pending')
    returning id into v_id;
  insert into op_contacts(slot_id, email, tel, remarques)
    values (v_id, p_email, p_tel, p_remarques);
  return v_id;
exception when exclusion_violation then
  raise exception 'overlap' using errcode = 'P0001';
end $$;

-- Droits : révoquer PUBLIC d'abord, puis accorder explicitement.
revoke all on function op_request(date,int,int,text,text,text,text,text,text,text) from public;
grant execute on function op_request(date,int,int,text,text,text,text,text,text,text) to anon, authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   set role anon;
--     select photo from op_slots;     -- doit MARCHER
--     select photo, module from public_events where module = 'op';
--   reset role;
