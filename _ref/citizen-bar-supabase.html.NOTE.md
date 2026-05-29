# Note sur l'artifact d'origine

L'artifact `citizen-bar-supabase.html` a été fourni en pièce jointe de chat
(pas comme fichier du repo). Son **design (CSS), ses champs de formulaire et sa
logique métier ont été portés** dans la nouvelle structure :

- CSS  -> `public/css/styles.css`
- Helpers date / escape -> `public/js/helpers.js`
- Portail -> `public/js/portal.js`
- Open Platine -> `public/js/open-platine.js`
- Radio Campus -> `public/js/radio-campus.js`
- Events (+ système à code) -> `public/js/events.js`
- Dashboards admin -> `public/js/admin.js` + sections admin de chaque module
- Couche storage (kv) -> remplacée par `public/js/storage.js` (repositories typés)
- Auth (code en dur) -> remplacée par `public/js/auth.js` (Supabase Auth)

Si tu veux conserver l'artifact original intact dans le repo, dépose-le
toi-même ici sous `citizen-bar-supabase.html`.
