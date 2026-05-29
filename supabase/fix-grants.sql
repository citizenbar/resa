-- =====================================================================
-- CORRECTIF — droits d'exécution des RPC + nettoyage des données de test
-- =====================================================================
-- À exécuter UNE FOIS dans le SQL Editor de Supabase, après schema.sql + policies.sql.
--
-- Pourquoi : en Postgres, toute fonction accorde EXECUTE à PUBLIC par défaut.
-- Le "grant to authenticated" initial ne restreignait donc pas ev_create_slot :
-- un visiteur anonyme pouvait générer des codes Events. On révoque PUBLIC/anon
-- sur les fonctions sensibles, puis on accorde explicitement les bons rôles.
-- (Ce correctif est désormais intégré dans policies.sql ; ce fichier sert à
--  patcher une base déjà créée sans tout re-rejouer.)
-- =====================================================================

-- --- RPC invité : anon + authenticated, sans PUBLIC large ---
revoke all on function op_request(date,int,int,text,text,text,text,text,text) from public;
revoke all on function rc_request(date,text,text,text,text,text,text,text,text) from public;
revoke all on function ev_claim_code(text) from public;
revoke all on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) from public;
grant execute on function op_request(date,int,int,text,text,text,text,text,text) to anon, authenticated;
grant execute on function rc_request(date,text,text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function ev_claim_code(text) to anon, authenticated;
grant execute on function ev_fill_slot(text,text,time,time,text,text,text,text,text,text,text,text) to anon, authenticated;

-- --- RPC ADMIN : authenticated UNIQUEMENT (corrige le trou) ---
revoke all on function ev_create_slot(date,text) from public;
revoke all on function ev_create_slot(date,text) from anon;
grant execute on function ev_create_slot(date,text) to authenticated;

-- --- Nettoyage des données de test créées pendant la vérification ---
delete from op_slots where event_date = '2099-01-07';   -- réservation de test (contacts supprimés en cascade)
delete from ev_slots where event_date = '2099-03-05';   -- slot Events de test
