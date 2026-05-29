-- Nettoyage du dernier créneau de test (vérification live des droits RPC).
-- À exécuter une fois dans le SQL Editor, puis ce fichier peut être supprimé.
delete from op_slots where event_date = '2099-01-08';
