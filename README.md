# resa — Citizen Bar (Tours)

Système de réservation pour un bar musical. Trois modules de réservation
(Open Platine, Radio Campus, Events) + un portail public (Agenda) qui agrège
les réservations validées en une liste chronologique.

Front HTML/CSS/JS vanilla (pas de framework, pas de build), Supabase en backend
(Postgres + API REST + Auth), déploiement statique sur Vercel.

> État actuel : **échafaudage**. Le front (UI, calendriers, timeline, système à
> code) est complet et fonctionne. La couche d'accès aux données
> (`js/storage.js`) et l'auth (`js/auth.js`) sont des **stubs** à câbler une fois
> le projet Supabase créé. Tant que `config.js` contient les placeholders, une
> bannière le signale et rien n'est enregistré.

## Logique métier

| Module | Quand | Horaires | Particularités |
|---|---|---|---|
| **Open Platine** | mercredis | 19h30 – 02h00 | Inscription libre, créneaux 1h-4h, détection de chevauchement (timeline visuelle). Premier arrivé, premier servi. |
| **Radio Campus** | mar-dim (fermé lundi + mercredi) | 19h00 – 21h30 | Un créneau par jour. Réservation min. 14 jours à l'avance. |
| **Events** | tous sauf lundi | 21h30 – 02h00 | Système à code : l'admin crée la soirée + un code 4 chiffres unique, l'envoie au DJ hors-ligne. Le DJ saisit le code (usage unique) et remplit sa fiche. |
| **Agenda** (portail) | — | — | Lecture seule. Agrège les réservations `validated` des trois modules. |

**Statuts** (sur chaque réservation) : `pending` (en attente, créneau bloqué)
-> `validated` (visible sur l'agenda public) -> `refused` (créneau libéré).
La validation se fait depuis le dashboard admin de chaque module.

## Arborescence

```
resa/
├── README.md                  # ce fichier
├── vercel.json                # déploiement statique (outputDirectory: public)
├── .vercelignore              # exclut _ref/, supabase/ du déploiement
├── .gitignore
│
├── public/                    # racine servie par Vercel
│   ├── index.html             # single-page : header + onglets + <main id="app">
│   ├── css/
│   │   └── styles.css         # design éditorial (Bowlby One / Fraunces / JetBrains Mono)
│   └── js/                    # chargés dans cet ordre par index.html :
│       ├── config.js          # window.CONFIG : URL + clé anon (placeholders), authMode
│       ├── supabase-client.js # init client Supabase depuis le SDK CDN -> window.sb
│       ├── helpers.js         # dates (dk/parseDk/timeToMin +24h), escapeHtml, constantes
│       ├── storage.js         # [STUB] repositories OpStore / RcStore / EvStore
│       ├── auth.js            # [STUB] Supabase Auth (signIn/signOut/session)
│       ├── admin.js           # login/logout partagés des 3 dashboards
│       ├── portal.js          # Agenda public (agrège les validés)
│       ├── open-platine.js    # module Open Platine (calendrier + timeline + admin)
│       ├── radio-campus.js    # module Radio Campus (calendrier + admin)
│       ├── events.js          # module Events (système à code + admin)
│       └── router.js          # état global, go(tab), render(), boot
│
├── supabase/
│   ├── schema.sql             # modèle relationnel cible + section kv (migration)
│   └── policies.sql           # RLS par rôle (lecture publique / écriture admin)
│
└── _ref/                      # spec d'origine (hors déploiement)
    └── BRIEF.md               # brief de passation
```

## Architecture front

- **Single-page, un seul scope de données.** `index.html` charge tous les
  scripts ; la navigation entre Agenda / Open Platine / Radio Campus / Events
  se fait par onglets (`go(tab)` dans `router.js`), sans rechargement. Choix
  hérité de l'artifact d'origine : trois modules + portail partagent les mêmes
  données, donc un seul scope évite la duplication.
- **Pas de bundler, pas de modules ES.** Chaque script expose ses symboles sur
  `window`. Le SDK Supabase est chargé via CDN. Ouvrable directement dans un
  navigateur (`public/index.html`).
- **Chaque module est un objet** (`OpenPlatine`, `RadioCampus`, `Events`,
  `Portal`) avec ses propres `view` / `render*` / `loadAdmin` / `setStatus`.
  Les dashboards admin partagent `admin.js` (login/logout) et `auth.js`.

## Couche données (`storage.js`)

Deux niveaux, pour rendre la migration progressive :

1. **Transport bas niveau** `sget / sset / sdel / slist` — reproduit
   l'abstraction clé-valeur de l'artifact (table `kv`, clés `cb:op:` /
   `cb:rc:` / `cb:ev:` / `cb:ev:codes`). C'est le chemin le plus court pour
   démarrer.
2. **Repositories typés** `OpStore / RcStore / EvStore` — la surface que les
   modules appellent. En passant au modèle relationnel, on réimplémente ces
   méthodes sans toucher aux modules UI.

Aujourd'hui ces fonctions sont des **stubs** (renvoient vide, marquent
`LAST_STORAGE_ERROR`). À câbler quand Supabase existe.

## Sécurité

Ce qui change par rapport à l'artifact d'origine (qui avait un code admin en
dur côté client et des RLS toutes ouvertes) :

- **Auth admin via Supabase Auth** (email/mot de passe), plus de code en dur.
  Le compte se crée dans Supabase (Authentication → Users). Voir `auth.js`.
- **RGPD** : `schema.sql` sépare les données publiques (nom de scène, styles,
  horaires) des contacts (email, tél) dans des tables `*_contacts` privées,
  jamais exposées en lecture publique.
- **RLS par rôle** (`policies.sql`) : lecture publique limitée aux lignes
  `validated` sans contacts ; validate/refuse/delete réservés à
  `authenticated`.
- La **clé anon** dans `config.js` est publique par nature (protégée par les
  RLS). Ne **jamais** mettre la clé `service_role` côté client.

> Parcours DJ Events : la saisie d'un code ne doit pas ouvrir `ev_slots` en
> lecture anonyme (fuite des codes). `policies.sql` note le TODO : une RPC
> `SECURITY DEFINER` qui prend le code et renvoie le seul slot concerné.

## Mise en route

1. **Créer le projet Supabase** (région EU recommandée).
2. **SQL** : exécuter `supabase/schema.sql` puis `supabase/policies.sql` dans
   le SQL Editor.
   - Pour démarrer vite avec la couche kv (sans réécrire `storage.js`),
     décommente la section *MIGRATION KV* dans les deux fichiers.
3. **Compte admin** : Supabase → Authentication → Users → Add user.
4. **Config** : dans `public/js/config.js`, remplacer `supabaseUrl` et
   `supabaseAnonKey` par les valeurs du projet (Settings → API).
5. **Câbler** la logique réelle dans `js/storage.js` et `js/auth.js`
   (les `TODO(supabase)` indiquent où).
6. **Tester** localement : ouvrir `public/index.html` ou servir le dossier
   (`npx serve public`).

## Déploiement (Vercel)

Site statique, pas de build. `vercel.json` sert `public/` (`outputDirectory`),
active `cleanUrls`, et pose quelques en-têtes de sécurité. `_ref/` et
`supabase/` sont exclus via `.vercelignore`.

```
vercel        # preview
vercel --prod # production
```

## Reste à faire

- [ ] Créer le projet Supabase + renseigner `config.js`.
- [ ] Exécuter `schema.sql` + `policies.sql`, créer le compte admin.
- [ ] Câbler `storage.js` (transport ou repositories) et `auth.js`.
- [ ] RPC Events (`ev_claim_code`, `ev_fill_slot`) pour le parcours à code.
- [ ] Tester de bout en bout (DJ réserve, admin valide).
- [ ] Déployer sur Vercel.
- [ ] (Plus tard) Notifications email — EmailJS ou Edge Function Supabase.
```
