# Citizen Bar — Brief de passation

> Document de référence (spec fonctionnelle d'origine). Conservé hors déploiement.
> La nouvelle structure (modules éclatés, Supabase Auth, schéma relationnel) est
> décrite dans le README à la racine.

## Contexte métier

Le Citizen Bar (Tours) a trois besoins de réservation distincts qu'on a consolidés
dans une seule application web :

1. **Open Platine** — soirée DJ open decks du mercredi (19h30 - 02h00).
   Inscription libre, créneaux 1h à 4h, détection de chevauchement.
2. **Radio Campus** — émission radio en direct du bar, un créneau par jour
   (19h00 - 21h30), du mardi au dimanche (fermé lundi + mercredi),
   réservation minimum 14 jours à l'avance.
3. **Events** — soirées programmées (21h30 - 02h00, fermé lundi).
   Système à code : l'admin crée la soirée + génère un code 4 chiffres unique,
   l'envoie au DJ hors-ligne (WhatsApp / Insta / email).
   Le DJ entre le code (usage unique), remplit ses horaires et sa fiche.

S'ajoute un **portail public** (vue par défaut "Agenda") qui agrège les
réservations validées des trois modules en une liste chronologique.

## Décisions d'architecture (artifact d'origine)

- **Un seul artifact / un seul fichier HTML standalone**, pas trois sites
  séparés. Trois onglets + portail = un seul scope de données.
- **Pas de React, pas de framework** : HTML + CSS + JS vanilla.
- **Statuts à trois valeurs** sur chaque réservation :
  `pending` (en attente, créneau bloqué) -> `validated` (visible au public) ->
  `refused` (créneau libéré). Validation par l'admin via dashboard.
- **Code admin unique** pour les trois dashboards, défini dans `CONFIG.adminCode`.
  Une fois saisi, l'auth est conservée en mémoire pour la session.

## Couche de persistance — Supabase (artifact d'origine)

La couche storage est une abstraction clé-valeur (`sget` / `sset` / `sdel` / `slist`)
qui tape sur une **table Postgres unique** `kv (key text primary key, value jsonb)`
via l'API REST PostgREST de Supabase.

Schéma des clés :

- `cb:op:YYYY-MM-DD` -> `{ slots: { id: {nom,email,tel,instagram,styles,debut,duree,status,...} } }`
- `cb:rc:YYYY-MM-DD` -> `{ emission,animateur,email,tel,style,micros,materiel,remarques,status,createdAt }`
- `cb:ev:YYYY-MM-DD` -> `{ slots: { id: {code,soiree,nom,debut,fin,form:{...},status,createdAt} } }`
- `cb:ev:codes`     -> `{ "1234": {dateKey, slotId}, ... }`  (index global des codes)

Chaque date est sa propre ligne — verrouillage par ligne au niveau Postgres,
collision possible uniquement entre deux écritures sur la même date. Couvert
par relecture-avant-écriture dans la logique applicative.

RLS d'origine (toutes ouvertes) :
- `select using (true)` — lecture publique
- `insert with check (true)` — insertion publique
- `update using (true) with check (true)` — update publique
- `delete using (true)` — delete publique

## Points de sécurité à durcir (adressés dans la nouvelle structure)

1. **Auth admin** : dans l'artifact, le code admin n'est qu'un mot de passe côté
   client (visible dans le source), et toutes les écritures (validation, refus,
   suppression) passent par la même RLS ouverte. Le bon durcissement :
   Supabase Auth (email/password) pour le compte admin, RLS qui restreint
   update/delete à `auth.role() = 'authenticated'`.
   -> Nouvelle structure : `js/auth.js` + `supabase/policies.sql`.

2. **Données personnelles (RGPD)** : la lecture publique expose les emails et
   téléphones des DJs/animateurs, pas seulement ce qui s'affiche sur l'agenda.
   Refonte propre : séparer une table publique (nom, styles, horaires) et une
   table privée (contacts) réservée à l'admin authentifié.
   -> Nouvelle structure : `supabase/schema.sql` (séparation public/privé).

## Logique métier conservée (depuis le design ChatGPT initial)

- Modèle à trois statuts (attente / validé / refusé).
- Timeline visuelle Open Platine + helper `timeToMin` avec gestion +24h après minuit.
- Système à code Events (un code = un slot, à usage unique).

## Stack technique

- Frontend : HTML standalone, CSS custom (variables, color-mix), JS vanilla ES2020.
- Polices : Google Fonts (Bowlby One, Fraunces, JetBrains Mono).
- Backend : Supabase (Postgres + PostgREST + Auth), région EU recommandée.
- Hébergement cible : Vercel (statique). (L'artifact visait GitHub Pages.)

## Reste à faire (roadmap)

- [ ] Créer le projet Supabase, renseigner supabaseUrl + supabaseAnonKey dans `public/js/config.js`.
- [ ] Exécuter `supabase/schema.sql` puis `supabase/policies.sql`.
- [ ] Créer le compte admin (Supabase → Authentication → Users).
- [ ] Câbler la couche données réelle dans `js/storage.js` et `js/auth.js`.
- [ ] Tester en conditions réelles (DJ qui réserve, admin qui valide).
- [ ] Déployer sur Vercel.
- [ ] (Plus tard) Notifications email — EmailJS ou Edge Function Supabase.
