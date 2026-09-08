-- =====================================================================
-- RADIO CAMPUS — confidentialité + champ photo (septembre 2026)
-- =====================================================================
-- À exécuter UNE FOIS dans le SQL Editor de Supabase, en entier, APRÈS
-- migrate-public-events.sql. Rejouable sans dommage.
--
-- CE FICHIER NE CHANGE AUCUNE RÈGLE MÉTIER. Les créneaux (fermé lundi et
-- mercredi, 19h00-21h30) et le délai de réservation (14 jours minimum)
-- restent exactement ce qu'ils sont aujourd'hui. Seuls deux défauts sont
-- corrigés, plus un garde-fou serveur.
--
-- CONTEXTE : migrate-public-events.sql a migré op_slots et ev_slots vers le
-- modèle "colonnes promo publiques", mais a oublié Radio Campus à mi-chemin.
-- Résultat aujourd'hui en production :
--   - rc_reservations.photo et .instagram EXISTENT, sont lisibles par anon et
--     publiées dans /events.json... mais AUCUNE écriture ne les alimente
--     (rc_request n'a jamais été réécrite). Colonnes mortes.
--   - la vue public_events publie `animateur || ' · ' || style` en sous-titre :
--     le nom de l'animateur part dans le flux public JSON, alors que seul le
--     nom de l'émission doit être public.
--
-- CE QUE CE FICHIER CORRIGE :
--   1. Confidentialité : anon ne lit plus que émission / date / statut / photo.
--      animateur, style, micros, materiel deviennent admin-only.
--   2. rc_request accepte enfin p_photo, écrit dans rc_reservations.photo —
--      la colonne déjà prévue et déjà publiée.
--   3. Garde-fou : le délai de 14 jours est appliqué CÔTÉ SERVEUR en plus du
--      front (qui est contournable).
--
-- ORDRE DE DÉPLOIEMENT : ce SQL D'ABORD, le front ENSUITE. p_photo a une valeur
-- par défaut, donc l'ancien front continue de fonctionner entre les deux : il
-- n'y a aucune fenêtre de casse. L'inverse (front d'abord) casserait toutes les
-- réservations Radio Campus jusqu'à l'exécution du SQL.
--
-- CHOIX ASSUMÉ SUR LA PHOTO : elle reste PUBLIQUE. C'est de la donnée de
-- promotion, destinée à être diffusée, et c'est ce qui rend /events.json
-- utilisable par l'extérieur — l'objectif du flux. Pour la fermer malgré tout :
-- retirer `photo` du grant à anon (§1) et la remplacer par null dans la vue (§2).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. GRANTS COLONNE — anon : émission, date, statut, photo. Rien d'autre.
-- ---------------------------------------------------------------------
revoke select on rc_reservations from anon;
grant select (id, event_date, emission, status, photo) on rc_reservations to anon;

-- L'admin continue de tout lire.
grant select on rc_reservations to authenticated;

-- ---------------------------------------------------------------------
-- 2. VUE PUBLIQUE — le nom de l'animateur ne sort plus dans le flux
-- ---------------------------------------------------------------------
-- L'horaire 19:00 est CONSERVÉ : c'est bien le créneau du bar.
-- create or replace view impose de garder noms ET types de colonnes : on
-- remplace par null::text uniquement là où on ferme la donnée.
create or replace view public_events as
  select id, 'op'::text as module, event_date,
         lpad((debut_min/60 % 24)::text,2,'0')||':'||lpad((debut_min % 60)::text,2,'0') as heure,
         debut_min as sort_min, dj_nom as titre, styles as sous_titre,
         styles, null::text as format, instagram, null::text as soundcloud, null::text as photo
    from op_slots where status = 'validated'
  union all
  select id, 'rc', event_date, '19:00', 19*60,
         emission, null::text,           -- <— sous_titre : plus d'animateur
         null::text,                     -- <— styles : fermé aussi
         null, null::text, null, photo   -- format, instagram, soundcloud, photo
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

-- public_agenda (le calendrier du site) publie animateur en sous-titre pour la
-- branche 'rc'. Même correctif, horaire 19:00 conservé.
create or replace view public_agenda as
  select 'op'::text as module,
         event_date,
         lpad((debut_min/60 % 24)::text,2,'0') || ':' || lpad((debut_min % 60)::text,2,'0') as heure,
         debut_min as sort_min,
         dj_nom as titre,
         styles as sous_titre
    from op_slots where status = 'validated'
  union all
  select 'rc', event_date, '19:00', 19*60,
         emission, null::text            -- <— plus d'animateur ni de style
    from rc_reservations where status = 'validated'
  union all
  select 'ev', event_date,
         coalesce(to_char(debut,'HH24:MI'), '21:30'),
         coalesce(extract(hour from debut)::int, 21) * 60 + coalesce(extract(minute from debut)::int, 30),
         soiree, dj_nom || coalesce(' · ' || styles, '')
    from ev_slots where status = 'validated';

alter view public_agenda set (security_invoker = on);

-- ---------------------------------------------------------------------
-- 3. rc_request v2 — p_photo + garde-fou du délai de 14 jours
-- ---------------------------------------------------------------------
-- La signature passe de 9 à 10 arguments : un "create or replace" créerait une
-- SURCHARGE au lieu de remplacer. On drop explicitement l'ancienne version.
drop function if exists rc_request(date,text,text,text,text,text,text,text,text);

-- NB : le 14 est dupliqué ici et dans RC_MIN_DAYS de public/js/radio-campus.js.
-- Si tu changes l'un, change l'autre.
create or replace function rc_request(
  p_date date, p_emission text, p_animateur text, p_style text,
  p_micros text, p_materiel text,
  p_email text, p_tel text, p_remarques text,
  -- p_photo a une VALEUR PAR DÉFAUT : c'est ce qui permet à l'ancien front
  -- (qui n'envoie que 9 arguments) de continuer à fonctionner entre le moment
  -- où ce SQL est exécuté et le moment où le front est déployé. Sans ce
  -- défaut, il y aurait une fenêtre où toute réservation Radio Campus échoue.
  p_photo text default ''
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- Délai minimum appliqué côté serveur : le calendrier du front grise déjà les
  -- dates trop proches, mais rien n'empêche d'appeler la RPC directement.
  if p_date < current_date + 14 then
    raise exception 'window' using errcode = 'P0001';
  end if;

  insert into rc_reservations(event_date, emission, animateur, style, micros, materiel, photo, status)
    values (p_date, p_emission, p_animateur, p_style, p_micros, p_materiel, p_photo, 'pending')
    returning id into v_id;
  insert into rc_contacts(reservation_id, email, tel, remarques)
    values (v_id, p_email, p_tel, p_remarques);
  return v_id;
exception when unique_violation then
  raise exception 'taken' using errcode = 'P0001';
end $$;

-- Droits : révoquer PUBLIC d'abord (Postgres accorde EXECUTE à PUBLIC par
-- défaut sur toute nouvelle fonction), puis accorder explicitement.
revoke all on function rc_request(date,text,text,text,text,text,text,text,text,text) from public;
grant execute on function rc_request(date,text,text,text,text,text,text,text,text,text) to anon, authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   set role anon;
--     select emission  from rc_reservations;  -- doit MARCHER
--     select photo     from rc_reservations;  -- doit MARCHER
--     select animateur from rc_reservations;  -- doit ÉCHOUER  <— le correctif
--     select micros    from rc_reservations;  -- doit ÉCHOUER
--     select heure, titre, sous_titre from public_events where module = 'rc';
--        -- heure = 19:00, sous_titre = null
--   reset role;
--
--   select rc_request(current_date + 3, 'Test','X','','1','','a@b.c','06','','');
--        -- doit ÉCHOUER avec 'window'
