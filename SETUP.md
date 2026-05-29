# Mise en route — Citizen Bar / resa

Le code est prêt et câblé. Il te reste à créer le projet Supabase et à coller
3 valeurs. Suis les étapes dans l'ordre. À la fin, l'app fonctionne.

Durée : ~15 minutes. Aucune compétence technique requise au-delà du copier-coller.

---

## Étape 1 — Créer le projet Supabase

1. Va sur https://supabase.com → **Sign in** (compte gratuit suffisant).
2. **New project**.
   - **Name** : `citizen-bar` (peu importe).
   - **Database Password** : génère-en un fort, **garde-le de côté** (tu n'en auras pas besoin pour l'app, mais Supabase le demande).
   - **Region** : choisis **West EU (Paris)** ou **Central EU (Frankfurt)** (RGPD + proximité Tours).
3. Clique **Create new project** et attends ~2 min que la base se provisionne.

---

## Étape 2 — Créer les tables et la sécurité (2 scripts SQL)

Dans le menu de gauche : **SQL Editor** → **New query**.

1. Ouvre le fichier [supabase/schema.sql](supabase/schema.sql) de ce projet, **copie tout**, colle dans l'éditeur, clique **Run** (en bas à droite).
   - Tu dois voir `Success. No rows returned`.
2. **New query** à nouveau. Ouvre [supabase/policies.sql](supabase/policies.sql), copie tout, colle, **Run**.
   - Pareil : `Success`.

> Si une erreur rouge apparaît, ne continue pas : copie-moi le message, je corrige.

À ce stade, la base contient les tables (Open Platine, Radio Campus, Events),
la sécurité (RLS) et les fonctions. Tu peux le vérifier dans **Table Editor** :
tu dois voir `op_slots`, `rc_reservations`, `ev_slots`, etc.

---

## Étape 3 — Créer le compte admin

Menu de gauche : **Authentication** → **Users** → **Add user** → **Create new user**.

- **Email** : l'email avec lequel l'équipe du bar se connectera au dashboard.
- **Password** : un mot de passe solide.
- ✅ Coche **Auto Confirm User** (sinon le compte attend une confirmation par email).
- **Create user**.

C'est ce couple email + mot de passe que tu saisiras dans l'app pour valider/refuser les réservations.

> Désactive les inscriptions publiques pour que personne d'autre ne puisse créer
> de compte admin : **Authentication → Sign In / Providers → Email**, et mets
> **Allow new users to sign up** sur **OFF**. (L'app ne propose pas d'inscription,
> mais autant fermer la porte.)

---

## Étape 4 — Récupérer les 2 valeurs à me donner

Menu de gauche : **Project Settings** (la roue dentée) → **API**.

Note ces **deux** valeurs :

1. **Project URL** — ressemble à `https://abcdefgh.supabase.co`
2. **Project API keys → `anon` `public`** — une longue chaîne qui commence par `eyJ...`

> ⚠️ Ne me donne **PAS** la clé `service_role` (elle est secrète et contourne la
> sécurité). Seules l'URL et la clé **anon/public** sont nécessaires, et elles
> sont prévues pour être publiques.

---

## Ce que tu me renvoies

Copie-colle moi juste ça :

```
SUPABASE_URL = https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY = eyJ.....(la clé anon public)
```

Je les place dans [public/js/config.js](public/js/config.js), je relance une
vérification, et l'app est opérationnelle en local. Ensuite on déploie sur Vercel.

---

## (Optionnel) Tu peux le faire toi-même

Si tu préfères ne rien m'envoyer : ouvre [public/js/config.js](public/js/config.js)
et remplace les deux lignes :

```js
supabaseUrl: 'https://TON-PROJET.supabase.co',   // -> ton Project URL
supabaseAnonKey: 'TA_CLE_ANON_PUBLIQUE',         // -> ta clé anon public
```

Puis ouvre `public/index.html` dans un navigateur (ou `npx serve public`). La
bannière rouge "backend non configuré" doit disparaître. Teste : réserve un
créneau Open Platine, connecte-toi à l'espace admin, valide-le, vérifie qu'il
apparaît dans l'Agenda.

---

## Après (je m'en occupe quand tu veux)

- **Déploiement Vercel** : `vercel --prod` (le site est statique, pas de build).
- **Tests de bout en bout** : je déroule les 5 scénarios clés (réservation,
  validation, code Events à usage unique, anti-chevauchement, anti-double-réservation).
- **Notifications email** (plus tard) : à brancher via une Edge Function Supabase.
