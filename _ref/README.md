# _ref — Référence (hors déploiement)

Ce dossier contient la spec d'origine. Il est exclu du déploiement Vercel
(voir `.vercelignore`).

- `BRIEF.md` — brief de passation (contexte métier, décisions, points de sécurité).
- `citizen-bar-supabase.html` — l'artifact single-page d'origine, fonctionnel,
  servant de référence pour le design (CSS), les champs de formulaire et la
  logique métier (calendriers, timeline, conflits, système à code).

La nouvelle structure (dans `public/`) régénère ce code proprement :
config externalisée, modules JS séparés, Supabase Auth, schéma relationnel.
Ne pas éditer ces fichiers de référence — ils figent l'état initial.
