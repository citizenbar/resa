# Ordre d'exécution des scripts SQL

Ce dossier n'est pas géré par un outil de migration : les scripts se jouent
**à la main** dans le SQL Editor de Supabase. L'ordre ci-dessous n'est pas
cosmétique, il est **correctif** : plusieurs fichiers tardifs redéfinissent des
objets créés plus tôt. Les jouer dans le désordre, ou rejouer un fichier ancien
après un récent, **régresse le schéma et peut réouvrir une faille de sécurité**
(voir « Pièges » plus bas).

Tous les scripts sont idempotents (`if not exists`, `create or replace`,
`drop policy if exists`) : rejouer la séquence complète dans l'ordre est sans
danger.

## Séquence

Sur une base neuve, exécuter dans cet ordre exact :

| # | Fichier | Rôle | Rejouable seul |
|---|---|---|---|
| 1 | `schema.sql` | Tables, contraintes, enum `booking_status`, vue `public_agenda` | oui |
| 2 | `policies.sql` | RLS par rôle + RPC (`op_request`, `rc_request`, `ev_claim_code`, `ev_fill_slot`, `ev_create_slot`) + grants d'exécution | **non**, voir piège 1 |
| 3 | `fix-grants.sql` | Correctif : `revoke public` avant `grant` sur les RPC (déjà intégré dans `policies.sql`, sert à patcher une base existante) | oui |
| 4 | `fix-column-leak.sql` | Correctif : grants au niveau **colonne** pour `anon` ; `public_agenda` passe en `security_invoker=on` | oui |
| 5 | `migrate-public-events.sql` | Colonnes promo sur les tables vitrine, vue `public_events`, **réécriture** de `op_request` et `ev_fill_slot` | oui |
| 6 | `storage-artist-photos.sql` | Bucket `artist-photos`, policies Storage, RPC `ev_can_upload` et `purge_orphan_artist_photos` | oui |
| 7 | `restrict-admin-emails.sql` | Table `admin_emails` + fonction `is_admin()` ; toutes les policies admin passent de `authenticated` à l'identité. **Prérequis de #10.** | oui |
| 8 | `rc-rules-2026-09.sql` | Radio Campus : grants `anon` resserrés (l'animateur ne sort plus du flux), `rc_request` réécrite avec `p_photo`, délai de 14 jours appliqué côté serveur | oui |
| 9 | `op-photo-2026-09.sql` | Open Platine : colonne `op_slots.photo`, exposée dans `public_events`, `op_request` réécrite avec `p_photo` | oui |
| 10 | `admin-edit-2026-09.sql` | Édition d'une fiche par l'admin : RPC `ev_admin_update`, `op_admin_update`, `rc_admin_update` | oui |
| 11 | `upload-quota-2026-09.sql` | Quota d'upload par IP (`upload_quota_take`) pour les modules sans code ; `purge_orphan_artist_photos` étendue aux photos RC et OP | oui |

**#8, #9 et #10 corrigent une migration laissée à mi-chemin.**
`migrate-public-events.sql` (#5) a déplacé les colonnes promo de `*_contacts`
vers `*_slots` puis supprimé les anciennes, mais Radio Campus n'a pas suivi :
`rc_reservations.photo` et `.instagram` étaient publiées sans qu'aucune écriture
ne les alimente. #8 referme ça. Le front qui lisait encore ces colonnes depuis
`*_contacts` (`events.js`, `open-platine.js`) a été corrigé dans la foulée : il
les lit désormais sur les tables vitrine, via les chemins admin.

`public-occupancy.sql` n'est pas dans la séquence : c'est un ajout indépendant.

`cleanup-test.sql` n'est pas une migration : c'est un ménage ponctuel des
créneaux de test créés pendant la vérification des droits (dates en 2099). À
jouer une fois si ces lignes existent, puis oubliable.

## Après la séquence

1. **Compte admin** : Supabase → Authentication → Users → Add user, avec
   *Auto Confirm User* coché. Puis Authentication → Sign In / Providers → Email
   → *Allow new users to sign up* sur **OFF**.
2. **Env vars Vercel** (Settings → Environment Variables) :
   - `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` : optionnelles, ces valeurs
     sont publiques et présentes en fallback dans `api/`.
   - `SUPABASE_SECRET_KEY` : **obligatoire** pour l'upload de photo. Sans elle,
     `api/upload-photo.js` refuse de signer (500 neutre). Aucun fallback en dur,
     par conception.

## Pièges

**1. Ne pas rejouer `policies.sql` seul sur une base à jour.** Il contient des
versions **antérieures** de `op_request` et `ev_fill_slot`, que
`migrate-public-events.sql` (#5) remplace : les versions récentes écrivent les
liens promo (`instagram`, `soundcloud`, `photo`) dans les tables `*_slots`, les
anciennes les écrivent dans les tables `*_contacts` dont ces colonnes ont été
supprimées à l'étape 3 de la migration. Rejouer #2 après #5 casse donc les
réservations Open Platine et le remplissage de fiche Events. Si tu dois rejouer
#2, rejoue #5 derrière.

**2. Deux vues publiques coexistent, c'est voulu.** `public_agenda` (créée en #1)
est lue par le front (`public/js/storage.js`) ; `public_events` (créée en #5) est
lue par les flux agent (`api/events.js`) et porte en plus les liens promo et
`format`. Les deux sont en `security_invoker=on` et filtrent
`status = 'validated'`. Toucher l'une n'affecte pas l'autre.

**3. `revoke public` avant `grant`.** En Postgres, toute nouvelle fonction
accorde `EXECUTE` à `PUBLIC` par défaut : un `grant execute ... to authenticated`
ne restreint donc **rien**, `anon` héritant de `PUBLIC`. Toute RPC ajoutée plus
tard doit reprendre le motif `revoke all on function ... from public;` puis
`grant execute ... to <rôles>`. C'est le trou qui laissait `anon` générer des
codes Events (corrigé en #3).

**4. RLS filtre la ligne, pas la colonne.** Un `GRANT SELECT` sur une table
expose **toutes** ses colonnes sur les lignes que la RLS laisse passer. C'est
ainsi que `ev_slots.code` et `rc_reservations.micros` fuyaient en accès anonyme.
Toute nouvelle colonne sensible doit rester **hors** des grants colonne d'`anon`
(#4 et #5) ; toute nouvelle colonne publique doit y être ajoutée explicitement,
sinon la vue en `security_invoker=on` ne pourra pas la lire.

**5. Le `CHECK *_not_past` gêne les UPDATE de masse.** Les contraintes
`event_date >= current_date` sont revérifiées à chaque UPDATE de la ligne : une
migration qui touche une ligne dont la date est passée échoue. D'où le filtre
`and event_date >= current_date` dans les UPDATE de #5.

**6. Une RPC `security definer` doit vérifier l'IDENTITÉ, pas la session.**
Depuis « Sign in with Google », Supabase crée un compte à la première connexion :
tout titulaire d'un compte Google est `authenticated`. Une garde
`if auth.uid() is null` ne prouve donc plus rien, et `grant execute to
authenticated` non plus. Toute RPC en `security definer` qui écrit des données
d'autrui doit appeler `is_admin()` (#7) dans son corps. Les trois
`*_admin_update` de #10 suivent ce motif.

**7. `when check_violation` sans filtre ment sur la cause.** Les tables portent
plusieurs CHECK (`op_not_past` mais aussi `op_within_window`). Un handler global
qui renomme toute violation en « event passé » affiche un message faux sur une
erreur d'horaire. Filtrer sur `sqlerrm like '%nom_contrainte%'` et re-lever le
reste avec un `raise` nu.

## Vérifier l'état d'une base

Contrôle rapide de la fuite colonne (#4 / #5) :

```sql
select has_column_privilege('anon', 'ev_slots', 'code', 'select');
-- attendu : false. true => la fuite colonne est ouverte, rejouer #4 puis #5.
```

Et la vérification fonctionnelle des droits `anon`, qui est la seule qui prouve
que la fermeture tient :

```sql
set role anon;
  select code from ev_slots;              -- doit ÉCHOUER (permission denied)
  select micros from rc_reservations;     -- doit ÉCHOUER
  select animateur from rc_reservations;  -- doit ÉCHOUER (depuis #8)
  select soiree, status from ev_slots;    -- doit MARCHER (colonnes vitrine)
  select instagram from ev_slots;         -- doit MARCHER (colonne promo, #5)
  select * from public_agenda;            -- doit MARCHER (lignes validées)
  select * from public_events;            -- doit MARCHER, avec instagram/photo
reset role;
```

## Ajouter une migration

1. Nouveau fichier daté ou nommé par intention, idempotent.
2. L'ajouter en fin de tableau ci-dessus, avec son rôle en une ligne.
3. Si elle redéfinit une RPC ou une vue existante, le dire explicitement dans
   les « Pièges », comme pour `migrate-public-events.sql`.
4. Reprendre le motif `revoke public` sur toute RPC, et décider explicitement
   des grants colonne pour `anon` sur toute nouvelle colonne.
