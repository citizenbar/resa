// =====================================================================
// CONFIG centralisée — Citizen Bar / resa
// =====================================================================
// Chargé en premier (avant tout autre script). Définit window.CONFIG.
//
// IMPORTANT — sécurité :
//   - supabaseAnonKey est une clé PUBLIQUE par nature. Elle est protégée
//     par les RLS Postgres (voir supabase/policies.sql). Elle peut figurer
//     ici sans risque, à condition que les RLS soient en place.
//   - NE JAMAIS mettre la clé service_role ici (elle bypasse les RLS).
//   - Il n'y a plus de code admin en dur (l'artifact d'origine en avait un,
//     CONFIG.adminCode='0000', visible dans le source). L'auth admin passe
//     désormais par Supabase Auth (email/mot de passe). Voir js/auth.js.
//
// Pour configurer : remplace les deux placeholders ci-dessous par les
// valeurs de ton projet Supabase (Settings → API).
// =====================================================================

window.CONFIG = {
  // ----- BACKEND SUPABASE -----
  // Projet "citizen-bar" (org tiyema), région Central EU (Frankfurt).
  supabaseUrl: 'https://wutzagmeeyzmqgzqaxwy.supabase.co',   // Project URL
  // Clé "publishable" (nouvelles clés Supabase ; remplace l'ancienne anon).
  // Publique par nature, protégée par les RLS. Ne JAMAIS mettre la secret key ici.
  supabaseAnonKey: 'sb_publishable_xcRt1nCgbYzQroWnmHITKg_teiyMDlh',

  // ----- AUTH ADMIN -----
  // 'supabase' = Supabase Auth (cible, recommandé). Le compte admin est créé
  // dans Supabase (Authentication → Users) ; aucun secret ne vit côté client.
  authMode: 'supabase',

  // ----- DIVERS -----
  notifyEmail: 'contact@citizenbar.fr',  // destinataire des notifications (étape ultérieure)
  timezone: 'Europe/Paris',
};

// Garde-fou : repère une config laissée en placeholder.
window.CONFIG.isConfigured = !!(
  window.CONFIG.supabaseUrl &&
  window.CONFIG.supabaseAnonKey &&
  !window.CONFIG.supabaseUrl.includes('TON-PROJET') &&
  !window.CONFIG.supabaseAnonKey.includes('TA_CLE')
);
