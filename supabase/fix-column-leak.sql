-- =====================================================================
-- CORRECTIF SÉCURITÉ — fuite RLS au niveau COLONNE (2026-06-05)
-- =====================================================================
-- À exécuter UNE FOIS dans le SQL Editor de Supabase, après schema.sql +
-- policies.sql (+ fix-grants.sql). Indépendant et rejouable.
--
-- LE PROBLÈME (vérifié en live sur la prod) :
--   Les policies RLS "status='validated'" filtrent la LIGNE, pas la COLONNE.
--   Or Supabase accorde par défaut `GRANT SELECT` (table entière) aux rôles
--   anon/authenticated. Résultat : dès qu'une ligne est validée, n'importe qui
--   avec la clé publishable (publique) peut lire TOUTES ses colonnes en SELECT
--   direct sur la table, en contournant la vue public_agenda. Concrètement,
--   en accès anonyme on pouvait lire :
--     - ev_slots.code (le code Events à 6 chiffres) + code_used
--     - rc_reservations.micros / materiel (notes logistiques internes)
--
-- LA PARADE :
--   RLS ne sait pas masquer une colonne. Le seul moyen est un GRANT au niveau
--   COLONNE : on révoque le SELECT "table entière" pour anon, puis on ne lui
--   accorde QUE les colonnes vitrine (publiques). L'admin (authenticated)
--   garde le SELECT complet pour continuer à tout lire.
--
-- LEÇON RÉUTILISABLE : un GRANT SELECT sur une table expose TOUTES ses
--   colonnes aux lignes que la RLS laisse passer. Pour cacher une colonne à
--   un rôle, il faut des grants colonne-par-colonne (ou ne lui donner que la
--   vue). Même esprit que le "revoke public avant grant" sur les RPC.
-- =====================================================================

-- ---------------------------------------------------------------------
-- anon : ne lit QUE les colonnes vitrine. Jamais code, code_used,
--        micros, materiel, created_at.
-- ---------------------------------------------------------------------
revoke select on op_slots        from anon;
revoke select on rc_reservations from anon;
revoke select on ev_slots        from anon;

-- Open Platine : colonnes publiques (nom de scène, styles, horaire, statut).
grant select (id, event_date, debut_min, duree_min, dj_nom, styles, status)
  on op_slots to anon;

-- Radio Campus : émission, animateur, style, statut. PAS micros/materiel.
grant select (id, event_date, emission, animateur, style, status)
  on rc_reservations to anon;

-- Events : soirée, nom DJ, horaires, styles, format, statut. PAS code/code_used.
grant select (id, event_date, soiree, dj_nom, debut, fin, styles, format, status)
  on ev_slots to anon;

-- ---------------------------------------------------------------------
-- authenticated (admin) : conserve le SELECT complet (lit tout, y compris
-- code/code_used/micros/materiel pour l'espace admin). Le revoke ci-dessus
-- ne visait qu'anon ; on (ré)affirme le grant table complet pour l'admin.
-- ---------------------------------------------------------------------
grant select on op_slots        to authenticated;
grant select on rc_reservations to authenticated;
grant select on ev_slots        to authenticated;

-- ---------------------------------------------------------------------
-- public_agenda : on passe la vue en security_invoker=on.
--   Avant : la vue tournait avec les droits du PROPRIÉTAIRE (défaut Postgres),
--   donc elle bypassait les RLS ; ce qui la protégeait, c'était uniquement le
--   "where status='validated'" écrit en dur dans sa définition. Fragile : un
--   futur élargissement de la vue, fait en croyant que "les RLS protègent",
--   ouvrirait une fuite.
--   Après : la vue applique les RLS du rôle appelant (anon ne voit donc que ce
--   qu'il a le droit de voir). Double filet : where de la vue + RLS. Et la
--   doc redevient vraie.
-- ---------------------------------------------------------------------
alter view public_agenda set (security_invoker = on);
grant select on public_agenda to anon, authenticated;

-- =====================================================================
-- VÉRIFICATION (à lancer après, dans le SQL Editor) :
--   Pour simuler anon :  set role anon;
--     select code from ev_slots;            -> doit ÉCHOUER (permission denied)
--     select micros from rc_reservations;   -> doit ÉCHOUER
--     select soiree, status from ev_slots;  -> doit MARCHER (colonnes vitrine)
--     select * from public_agenda;          -> doit MARCHER (lignes validées)
--   Pour revenir admin :  reset role;
-- =====================================================================
