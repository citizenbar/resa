-- =====================================================================
-- UPLOAD PHOTO SUR UNE SOIRÉE PASSÉE : refuser proprement (septembre 2026)
-- =====================================================================
-- À exécuter APRÈS storage-artist-photos.sql. Rejouable.
--
-- LE BUG, reproduit en production :
--
--   select ev_can_upload('203301');   -- code valide, soirée du 2026-09-02
--   ERROR: 23514: new row for relation "ev_slots"
--          violates check constraint "ev_not_past"
--
-- ev_can_upload incrémente upload_count par un UPDATE sur ev_slots. Postgres
-- revérifie alors TOUS les CHECK de la ligne, y compris ev_not_past
-- (event_date >= current_date) — c'est le piège n°5 de MIGRATIONS.md. Toute
-- écriture sur une ligne dont la date est passée échoue, même quand la date
-- n'est pas touchée.
--
-- CONSÉQUENCE POUR L'UTILISATEUR : la RPC lève une exception au lieu de
-- renvoyer false. api/upload-photo.js voit un appel en échec et répond
--
--   403 « code Events invalide, déjà utilisé, ou trop d'envois »
--
-- alors que le code est parfaitement valide et n'a rien épuisé. Le message
-- accuse le code et envoie le débogage dans la mauvaise direction : c'est la
-- DATE qui bloque. Un DJ qui s'y prend le lendemain de sa soirée croirait son
-- code cassé.
--
-- LE CORRECTIF : tester la date AVANT d'écrire, et renvoyer false comme pour
-- tout autre refus. Aucune exception, aucun message trompeur.
--
-- CE QUI NE CHANGE PAS : on n'uploade toujours pas de photo pour une soirée
-- passée. C'est cohérent avec le reste du produit — l'admin ne peut pas non
-- plus éditer une fiche passée (même CHECK), et la photo sert à annoncer une
-- soirée à venir. Seul le comportement en cas de refus est corrigé.
-- =====================================================================

begin;

create or replace function ev_can_upload(p_code text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int; v_date date;
begin
  select id, upload_count, event_date into v_id, v_n, v_date
    from ev_slots
   where code = p_code and code_used = false
   for update;
  if v_id is null then return false; end if;     -- code inconnu ou déjà scellé
  if v_n >= 5 then return false; end if;          -- max 5 uploads par code

  -- Soirée passée : on refuse AVANT d'écrire. Sans ce test, l'UPDATE
  -- ci-dessous ferait revalider ev_not_past par Postgres et lèverait une
  -- exception, que l'appelant traduirait en « code invalide » — un message
  -- faux, puisque le code est bon.
  if v_date < current_date then return false; end if;

  update ev_slots set upload_count = upload_count + 1 where id = v_id;
  return true;
end $$;

-- Droits inchangés (règle du projet : revoke public AVANT grant explicite).
revoke all on function ev_can_upload(text) from public;
revoke all on function ev_can_upload(text) from anon;
grant execute on function ev_can_upload(text) to anon, authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   -- sur un créneau dont la date est PASSÉE : false, et AUCUNE erreur
--   select ev_can_upload('<code d''un event passé>');   -- false
--
--   -- sur un créneau à venir : true, et upload_count incrémenté
--   select ev_can_upload('<code d''un event à venir>'); -- true
--
--   -- le compteur n'a PAS bougé sur l'event passé (aucune écriture tentée) :
--   select code, event_date, upload_count from ev_slots where event_date < current_date;
-- =====================================================================
