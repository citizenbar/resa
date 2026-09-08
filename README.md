# resa : Citizen Bar (Tours)

Système de réservation pour un bar musical. Trois modules de réservation
(Open Platine, Radio Campus, Events) + un portail public (Agenda) qui agrège
les réservations validées en une liste chronologique. La même programmation est
exposée en version agent-readable (`/events.yaml`, `/events.json`).

Front HTML/CSS/JS vanilla (pas de framework, pas de build, zéro dépendance npm),
Supabase en backend (Postgres + PostgREST + Auth + Storage), déploiement sur
Vercel avec deux Vercel Functions en Node natif.

> **État : en production.** Le backend est câblé et vérifié en live
> (`prog.citizenbar.fr`). Reste un point ouvert : le bucket Storage
> `artist-photos` n'est pas créé en prod, donc l'upload de photo d'artiste
> échoue. Voir [Reste à faire](#reste-à-faire).

## Logique métier

| Module | Quand | Horaires | Particularités |
|---|---|---|---|
| **Open Platine** | mercredis | 19h30 - 02h00 | Inscription libre, créneaux 1h-4h, détection de chevauchement (timeline visuelle). Premier arrivé, premier servi. |
| **Radio Campus** | mar-dim (fermé lundi + mercredi) | 19h00 - 21h30 | Un créneau par jour. Réservation min. 14 jours à l'avance. |
| **Events** | tous sauf lundi | 21h30 - 02h00 | Système à code : l'admin crée la soirée + un code 6 chiffres unique, l'envoie au DJ hors-ligne. Le DJ saisit le code (usage unique), remplit sa fiche et sa photo d'artiste (obligatoire). |
| **Agenda** (portail) | - | - | Lecture seule. Agrège les réservations `validated` des trois modules. |

**Statuts** (sur chaque réservation) : `pending` (en attente, créneau bloqué)
-> `validated` (visible sur l'agenda public) -> `refused` (créneau **libéré**).
La validation se fait depuis le dashboard admin de chaque module.

Le fait qu'un refus *rouvre* le créneau est câblé dans les contraintes SQL :
l'index unique de Radio Campus et l'exclusion gist d'Open Platine ne comptent
que les lignes `pending` + `validated`. Ce n'est pas une règle applicative
qu'on pourrait contourner depuis le client.

## Arborescence

```
resa/
├── README.md                  # ce fichier
├── README.svg                 # diagramme d'architecture de la stack
├── SETUP.md                   # pas-à-pas de création du projet Supabase
├── vercel.json                # statique + rewrites /events.{yaml,json} + en-têtes
├── .vercelignore              # exclut _ref/, supabase/, *.md du déploiement
│
├── public/                    # racine servie par Vercel
│   ├── index.html             # single-page : header + onglets + <main id="app">
│   ├── llms.txt               # pointeur agent-readable (convention llms.txt)
│   ├── css/styles.css         # design éditorial (Bowlby One / Fraunces / JetBrains Mono)
│   └── js/                    # chargés dans cet ordre par index.html :
│       ├── config.js          # window.CONFIG : URL + clé publishable, authMode
│       ├── supabase-client.js # init du client depuis le SDK CDN -> window.sb
│       ├── helpers.js         # dates (dk/parseDk/timeToMin +24h), escapeHtml, constantes
│       ├── storage.js         # repositories OpStore / RcStore / EvStore (seule couche qui connaît le schéma)
│       ├── auth.js            # Supabase Auth + déconnexion auto après 30 min d'inactivité
│       ├── admin.js           # login/logout partagés des 3 dashboards
│       ├── portal.js          # Agenda public (lit la vue public_agenda)
│       ├── open-platine.js    # module Open Platine (calendrier + timeline + admin)
│       ├── radio-campus.js    # module Radio Campus (calendrier + admin)
│       ├── events.js          # module Events (système à code + admin)
│       └── router.js          # état global, go(tab), render(), boot
│
├── api/                       # Vercel Functions (Node natif, zéro dépendance)
│   ├── events.js              # flux agent-readable YAML/JSON (lit la vue public_events)
│   └── upload-photo.js        # signe l'upload de photo d'artiste (clé secrète serveur)
│
├── supabase/
│   ├── MIGRATIONS.md          # ORDRE D'EXÉCUTION des scripts + pièges. À lire avant de toucher au SQL.
│   ├── schema.sql             # tables, contraintes, vue public_agenda
│   ├── policies.sql           # RLS par rôle + RPC SECURITY DEFINER
│   ├── fix-grants.sql         # correctif : revoke public avant grant
│   ├── fix-column-leak.sql    # correctif : grants au niveau colonne
│   ├── migrate-public-events.sql  # colonnes promo + vue public_events
│   └── storage-artist-photos.sql  # bucket + RPC ev_can_upload
│
├── scripts/sb.sh              # runner Supabase (SQL, bucket, sondes). Credentials via .env non commité.
│
├── docs/adr/                  # décisions d'architecture
│   └── 0001-hebergement-vercel-supabase-plutot-que-tout-cloudflare.md
│
└── _ref/BRIEF.md              # spec d'origine (hors déploiement)
```

## Décisions d'architecture

Les choix structurants sont consignés dans [`docs/adr/`](docs/adr/) :

- [0001](docs/adr/0001-hebergement-vercel-supabase-plutot-que-tout-cloudflare.md) :
  pourquoi l'hébergement reste sur Vercel + Supabase, et pourquoi on ne
  regroupe pas tout sur Cloudflare (qui sert déjà de DNS).

## Architecture front

- **Single-page, un seul scope de données.** `index.html` charge tous les
  scripts ; la navigation entre Agenda / Open Platine / Radio Campus / Events
  se fait par onglets (`go(tab)` dans `router.js`), sans rechargement. Les trois
  modules et le portail partagent les mêmes données, donc un seul scope évite la
  duplication.
- **Pas de bundler, pas de modules ES.** Chaque script expose ses symboles sur
  `window`. Le SDK Supabase est chargé via CDN (version épinglée). Ouvrable
  directement dans un navigateur (`public/index.html`).
- **Chaque module est un objet** (`OpenPlatine`, `RadioCampus`, `Events`,
  `Portal`) avec ses propres `view` / `render*` / `loadAdmin` / `setStatus`.
  Les dashboards admin partagent `admin.js` (login/logout) et `auth.js`.
- **`timeToMin` compte +24h avant 6h du matin** (`helpers.js`), pour que les
  créneaux qui passent minuit s'ordonnent correctement. Les colonnes
  `debut_min` en base suivent la même convention.

## Couche données (`storage.js`)

`storage.js` est la **seule** couche qui connaît le schéma relationnel. Elle
expose aux modules UI trois repositories (`OpStore` / `RcStore` / `EvStore`) qui
rendent les formes que l'UI attend, et fait les conversions (`"19:30"` <->
`debut_min`, `"2h"` <-> `duree_min`). Changer le schéma ne devrait toucher que
ce fichier.

Les écritures invité ne passent **jamais** par un INSERT direct : elles appellent
des RPC `SECURITY DEFINER` (`op_request`, `rc_request`, `ev_claim_code`,
`ev_fill_slot`), ce qui rend atomiques l'anti-chevauchement et l'usage unique du
code, et force `status = 'pending'` côté serveur. Le front ne fait pas de
« lire puis écrire » exposé aux courses.

Deux chemins de lecture pour Events, volontairement distincts : `getDate()` pour
le calendrier public (ne lit ni `code` ni `code_used`) et `getDateAdmin()` pour
le dashboard. Ce n'est pas de la cosmétique : ces colonnes sont fermées à `anon`
au niveau du GRANT, donc les demander en anon échoue.

## Sécurité

Le modèle est la partie la plus travaillée du projet, et trois pièges Postgres y
ont été corrigés après vérification en live. **Les leçons se rejouent facilement,
elles sont détaillées dans [`supabase/MIGRATIONS.md`](supabase/MIGRATIONS.md).**

- **Auth admin via Supabase Auth** (email/mot de passe), aucun secret côté
  client. Déconnexion automatique après 30 min d'inactivité (poste partagé au
  bar).
- **RGPD** : les contacts (email, tél, remarques) vivent dans des tables
  `*_contacts` séparées, jamais lisibles en anon. Les liens promo (instagram,
  soundcloud, photo) ont été délibérément sortis des contacts vers les tables
  vitrine : c'est de la donnée de diffusion, pas du contact.
- **`revoke public` avant `grant`** : en Postgres, toute fonction accorde
  `EXECUTE` à `PUBLIC` par défaut, donc un `grant to authenticated` ne restreint
  rien. C'est le trou qui laissait un visiteur anonyme générer des codes Events.
- **RLS filtre la ligne, pas la colonne** : un `GRANT SELECT` sur une table
  expose toutes ses colonnes des lignes que la RLS laisse passer. C'est ainsi que
  `ev_slots.code` et `rc_reservations.micros` fuyaient en anon. Parade : des
  grants colonne par colonne.
- **Upload de photo** : `anon` n'a aucune policy d'écriture sur le bucket. Le DJ
  passe par `api/upload-photo.js`, qui vérifie le code via la RPC `ev_can_upload`
  (elle consomme un crédit, ce qui ferme l'abus « uploads illimités par code »),
  puis signe une URL avec la clé secrète serveur ; le navigateur uploade en
  direct. La validation client (type + magic bytes) est contournable par nature :
  la vraie barrière est `allowed_mime_types` + `file_size_limit` sur le bucket.
- La **clé publishable** dans `config.js` est publique par nature (protégée par
  les RLS). Ne **jamais** mettre la clé secrète / `service_role` côté client :
  elle vit uniquement dans `SUPABASE_SECRET_KEY` sur Vercel, sans fallback en dur.

## Flux agent-readable

`api/events.js` sert la même information que le portail humain, sérialisée pour
un agent : YAML par défaut (`/events.yaml`), JSON en variante (`/events.json`),
découvrables via `rel=alternate` dans le `<head>` et via `public/llms.txt`.

La source est la vue `public_events`, qui ne contient que des colonnes publiques
et que des lignes validées. Le flux filtre en plus `event_date >= aujourd'hui`
(en heure de Paris) : **il ne montre que les événements à venir**, donc un
`count: 0` avec des lignes en base signifie simplement que toutes les dates sont
passées.

Le sérialiseur YAML est maison (pour tenir le zéro-dépendance) et quote
systématiquement toute valeur de chaîne façon JSON, ce qui ferme l'injection
YAML par une valeur venant de la base.

## Mise en route

Le pas-à-pas destiné à quelqu'un de non technique est dans [SETUP.md](SETUP.md).
En résumé :

1. **Projet Supabase** en région EU.
2. **SQL** : jouer les scripts **dans l'ordre imposé** par
   [`supabase/MIGRATIONS.md`](supabase/MIGRATIONS.md). L'ordre est correctif, pas
   cosmétique : certains fichiers tardifs redéfinissent des objets créés plus tôt.
3. **Compte admin** : Supabase → Authentication → Users → Add user
   (*Auto Confirm User*), puis désactiver les inscriptions publiques.
4. **Config** : `public/js/config.js` (URL + clé publishable).
5. **Env var Vercel** : `SUPABASE_SECRET_KEY`, obligatoire pour l'upload de photo.
6. **Tester** : ouvrir `public/index.html` ou `npx serve public`.

## Déploiement (Vercel)

Site statique, pas de build. `vercel.json` sert `public/` (`outputDirectory`),
active `cleanUrls`, réécrit `/events.{yaml,yml,json}` vers `api/events.js`, et
pose des en-têtes de sécurité (`nosniff`, `SAMEORIGIN`,
`strict-origin-when-cross-origin`). `_ref/`, `supabase/` et les `*.md` sont
exclus via `.vercelignore`.

```
vercel        # preview
vercel --prod # production
```

Production : <https://prog.citizenbar.fr> (projet Vercel `prog.citizenbar.fr`).

## Vérifier l'état d'une installation

Les sondes SQL et les tests de fermeture des droits `anon` sont dans
[`supabase/MIGRATIONS.md`](supabase/MIGRATIONS.md#vérifier-létat-dune-base). Pour
le déploiement, les trois URL qui doivent répondre 200 sont `/`, `/events.yaml`
et `/events.json`.

## Reste à faire

- [ ] **Créer le bucket Storage en prod** : jouer
      `supabase/storage-artist-photos.sql`. Vérifié le 2026-08-28, le bucket
      `artist-photos` répond `NoSuchBucket` alors que la photo d'artiste est
      obligatoire depuis le dernier commit : l'upload échoue donc en production.
      C'est le seul écart connu entre le code et la base.
- [ ] Purger les 3 réservations de test (mai-juin 2026) restées en base.
- [ ] Tester de bout en bout après création du bucket (DJ réserve avec photo,
      admin valide, l'event apparaît dans l'agenda et dans le flux YAML).
- [ ] (Plus tard) Notifications email : EmailJS ou Edge Function Supabase.
- [ ] (Plus tard) Brancher `purge_orphan_artist_photos()` sur un cron
      (pg_cron ou Vercel Cron) : la fonction existe, rien ne l'appelle.
