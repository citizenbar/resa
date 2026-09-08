-- =====================================================================
-- NETTOYAGE DES DONNÉES DE TEST
-- =====================================================================
-- Ce n'est PAS une migration : le schéma n'est pas touché. C'est un ménage
-- ponctuel des réservations créées pendant les vérifications (droits RPC,
-- fermeture des fuites colonne, recette du parcours DJ).
--
-- À exécuter dans le SQL Editor de Supabase, section par section. Rejouable :
-- les DELETE ne font rien si les lignes ont déjà disparu.
--
-- POURQUOI DELETE ET PAS UPDATE : les contraintes CHECK *_not_past
-- (event_date >= current_date) sont revérifiées à chaque UPDATE de la ligne.
-- Une ligne de test dont la date est passée ne peut donc plus être modifiée,
-- seulement supprimée. Les tables *_contacts partent en cascade (ON DELETE
-- CASCADE sur la clé étrangère), il n'y a rien à supprimer à la main.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ÉTAPE 1 : INVENTAIRE (à lancer d'abord, ne supprime rien)
-- ---------------------------------------------------------------------
-- Nécessaire parce qu'un contrôle en accès anonyme ne voit QUE les lignes
-- 'validated' : des lignes 'pending' ou 'refused' peuvent traîner sans être
-- visibles depuis l'extérieur. Ce select, lancé dans le SQL Editor (rôle
-- privilégié), montre TOUT. Regarde le résultat avant de passer à l'étape 2.
select 'op' as module, id::text, event_date, dj_nom   as intitule, status, created_at
  from op_slots
union all
select 'rc', id::text, event_date, emission, status, created_at
  from rc_reservations
union all
select 'ev', id::text, event_date, soiree,   status, created_at
  from ev_slots
order by event_date, module;


-- ---------------------------------------------------------------------
-- ÉTAPE 2 : SUPPRESSION DES LIGNES DE TEST CONNUES
-- ---------------------------------------------------------------------
-- Inventaire relevé le 2026-08-28 (les 3 lignes 'validated' visibles en prod,
-- toutes à des dates passées, donc déjà absentes du flux public) :
--
--   ev  2026-05-31  « Alex »       (d80e8467-cb33-486b-a63e-7c26039688d1)
--   op  2026-06-03  « Spectaclo »  (1f7a80a9-3a79-44ee-bf7d-be069f705963)
--   rc  2026-06-18  « Blabla »     (b0cbb7a4-625e-4a62-b51f-c24d5b6cdeb5)
--
-- Ciblage par ID : c'est le seul critère qui ne peut pas emporter une vraie
-- réservation par accident. Un filtre sur la date ou sur le nom risquerait
-- d'attraper une ligne légitime créée depuis.
delete from ev_slots        where id = 'd80e8467-cb33-486b-a63e-7c26039688d1';
delete from op_slots        where id = '1f7a80a9-3a79-44ee-bf7d-be069f705963';
delete from rc_reservations where id = 'b0cbb7a4-625e-4a62-b51f-c24d5b6cdeb5';

-- Anciens créneaux de test en 2099 (recette des droits RPC). Ici le filtre par
-- date est sûr : l'année 2099 n'est pas une réservation plausible.
delete from op_slots where event_date >= '2099-01-01';
delete from ev_slots where event_date >= '2099-01-01';
delete from rc_reservations where event_date >= '2099-01-01';


-- ---------------------------------------------------------------------
-- ÉTAPE 3 : VÉRIFICATION
-- ---------------------------------------------------------------------
-- Doit renvoyer 0 partout si la base ne contient plus que du réel.
-- (Relancer l'inventaire de l'étape 1 donne la vue détaillée.)
select (select count(*) from op_slots)        as op_restant,
       (select count(*) from rc_reservations) as rc_restant,
       (select count(*) from ev_slots)        as ev_restant,
       (select count(*) from op_contacts)     as op_contacts,
       (select count(*) from rc_contacts)     as rc_contacts,
       (select count(*) from ev_contacts)     as ev_contacts;

-- Contrôle de cohérence : aucun contact ne doit survivre sans sa réservation
-- (si ces compteurs ne sont pas à 0, la cascade n'a pas joué -> à investiguer).
select (select count(*) from op_contacts c where not exists (select 1 from op_slots        s where s.id = c.slot_id))        as op_orphelins,
       (select count(*) from rc_contacts c where not exists (select 1 from rc_reservations r where r.id = c.reservation_id)) as rc_orphelins,
       (select count(*) from ev_contacts c where not exists (select 1 from ev_slots        s where s.id = c.slot_id))        as ev_orphelins;


-- ---------------------------------------------------------------------
-- ÉTAPE 4 : PHOTOS DE TEST DANS LE STORAGE (si le bucket existe)
-- ---------------------------------------------------------------------
-- Les photos uploadées pendant une recette restent dans le bucket sans être
-- référencées dès que la réservation est supprimée. La fonction de purge
-- (storage-artist-photos.sql) ne prend que les objets de plus de 24h ; pour un
-- ménage immédiat après recette, l'appeler directement ne suffit donc pas.
--
-- Purge immédiate des orphelines, sans condition d'âge :
--   delete from storage.objects o
--    where o.bucket_id = 'artist-photos'
--      and not exists (select 1 from ev_slots s
--                       where s.photo is not null and s.photo like '%/' || o.name);
--
-- Volontairement commentée : à ne lancer qu'après avoir vérifié qu'aucun DJ
-- n'est en train de remplir sa fiche (une photo uploadée mais pas encore
-- scellée par ev_fill_slot n'est pas référencée, et serait donc supprimée).
