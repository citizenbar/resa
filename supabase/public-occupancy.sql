-- =====================================================================
-- OCCUPATION PUBLIQUE DES DATES (correctif UX, 2026-08-29)
-- =====================================================================
-- À exécuter APRÈS les migrations 1 à 6 et restrict-admin-emails.sql.
-- Rejouable.
--
-- LE PROBLÈME (constaté en production) :
--   Les policies RLS n'exposent à `anon` que les lignes 'validated'. Une
--   réservation 'pending' est donc TOTALEMENT invisible au visiteur : le
--   calendrier affiche la date comme libre, l'utilisateur remplit un
--   formulaire complet, et ne découvre le conflit qu'au moment d'envoyer
--   (« Trop tard, ce jour vient d'être réservé »), avec renvoi au
--   calendrier et perte de sa saisie. Pattern déceptif classique.
--
-- LA PARADE :
--   Exposer l'OCCUPATION sans exposer QUI occupe. Deux vues qui ne
--   renvoient qu'une date et un statut d'occupation :
--     - 'pending'   : une demande existe, pas encore tranchée
--     - 'validated' : la date est prise
--   Aucun nom, email, téléphone, émission, style ni remarque. Rien qui
--   permette d'identifier une personne : uniquement « cette date est
--   demandée » ou « cette date est prise ».
--
--   On NE touche PAS aux policies des tables de base : elles continuent de
--   ne laisser passer que les lignes validées. Ces vues sont un canal
--   séparé, en lecture seule, au périmètre minimal.
--
-- DÉCISION PRODUIT :
--   Une date 'pending' reste RÉSERVABLE (le visiteur est averti qu'une
--   autre demande est en cours et que la sienne peut être refusée). Une
--   date 'validated' n'est plus réservable du tout. C'est la RPC qui fait
--   foi : l'index unique rc_one_per_day rejette toujours une seconde
--   ligne non refusée, et l'exclusion gist fait de même pour Open Platine.
-- =====================================================================

-- ---------------------------------------------------------------------
-- RADIO CAMPUS : une seule réservation par jour. On renvoie le statut le
-- plus fort de la date ('validated' l'emporte sur 'pending').
-- ---------------------------------------------------------------------
create or replace view rc_occupancy as
  select event_date,
         case when bool_or(status = 'validated') then 'validated' else 'pending' end as occupancy
    from rc_reservations
   where status <> 'refused'          -- un refus rouvre la date
     and event_date >= current_date   -- le passé n'intéresse personne
   group by event_date;

-- ---------------------------------------------------------------------
-- OPEN PLATINE : plusieurs créneaux par soirée. On expose les PLAGES
-- occupées (début + durée en minutes) pour que la timeline et la
-- détection de chevauchement fonctionnent AVANT la saisie. Toujours
-- aucune donnée personnelle : ni nom de scène, ni styles, ni contact.
-- ---------------------------------------------------------------------
create or replace view op_occupancy as
  select event_date, debut_min, duree_min, status as occupancy
    from op_slots
   where status <> 'refused'
     and event_date >= current_date;

-- ---------------------------------------------------------------------
-- EVENTS : les slots sont créés par l'admin (pas de réservation libre),
-- mais le calendrier public doit distinguer une soirée programmée d'une
-- soirée déjà confirmée. Le nom de la soirée est déjà public sur les
-- lignes validées ; ici on n'expose QUE la date et l'occupation, donc
-- rien de neuf n'est divulgué pour les lignes en attente.
-- ---------------------------------------------------------------------
create or replace view ev_occupancy as
  select event_date,
         case when bool_or(status = 'validated') then 'validated' else 'pending' end as occupancy
    from ev_slots
   where status <> 'refused'
     and event_date >= current_date
   group by event_date;

-- ---------------------------------------------------------------------
-- security_invoker = on : les vues s'exécutent avec les droits de
-- l'appelant. Comme `anon` n'a PAS le droit de lire les lignes 'pending'
-- des tables de base, une vue en invoker ne renverrait rien.
--
-- Ces trois vues doivent donc rester en SECURITY DEFINER (le défaut
-- Postgres) : elles tournent avec les droits du propriétaire, ce qui leur
-- permet de voir les lignes pending. C'est SÛR ici parce que leur
-- définition ne projette QUE des colonnes non identifiantes (date,
-- horaires, statut) : il n'existe aucune colonne sensible à filtrer.
--
-- C'est l'exception assumée à la règle posée dans fix-column-leak.sql
-- (« les vues publiques passent en security_invoker »). La raison : ici on
-- veut précisément montrer une information que la RLS cache, réduite au
-- strict minimum. Toute évolution de ces vues doit re-vérifier qu'aucune
-- colonne identifiante n'y entre.
-- ---------------------------------------------------------------------
grant select on rc_occupancy to anon, authenticated;
grant select on op_occupancy to anon, authenticated;
grant select on ev_occupancy to anon, authenticated;

-- =====================================================================
-- VÉRIFICATION (SQL Editor)
-- =====================================================================
--   set role anon;
--     select * from rc_occupancy;      -- doit MARCHER : dates + occupancy
--     select * from op_occupancy;      -- doit MARCHER : plages occupées
--     -- et la confidentialité tient toujours :
--     select emission from rc_reservations;  -- ne renvoie QUE les validées
--     select micros from rc_reservations;    -- doit ÉCHOUER (42501)
--     select code from ev_slots;             -- doit ÉCHOUER (42501)
--   reset role;
--
-- CONTRÔLE DE NON-RÉGRESSION : les vues ne doivent JAMAIS contenir de
-- colonne identifiante. Si une évolution y ajoute un nom, une émission ou
-- un contact, elle divulguerait des lignes en attente que la RLS protège.
-- =====================================================================
