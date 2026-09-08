// =====================================================================
// ROUTER — état global + navigation par onglets + boot
// =====================================================================
// Single-page : un seul scope de données, navigation par onglets (pas de
// rechargement). Chargé EN DERNIER (après les modules) ; appelle render().
// =====================================================================

const state = {
  // portal | op | rc | ev  (+ 'login' : onglet VIRTUEL, écran de connexion
  // admin, qui n'a pas de bouton dans la barre de navigation)
  tab: 'portal',
};

function setAccent(tab){
  document.documentElement.style.setProperty('--accent', MODULE_ACCENT[tab] || 'var(--op)');
}

function go(tab){
  state.tab = tab;
  // 'login' est un onglet virtuel : il garde l'accent courant, et aucun
  // bouton de la barre ne s'active (aucun n'a data-tab="login").
  if (tab !== 'login') setAccent(tab);
  syncModuleViews();   // vue de départ du module selon l'état admin
  document.querySelectorAll('#mainTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function render(){
  const app = document.getElementById('app');

  // Chrome global : bouton ⚡ du header + bandeau « mode admin ».
  if (window.Admin) { Admin.renderHeaderButton(); Admin.renderBanner(); }

  // Écran de connexion global (onglet virtuel, hors navigation publique).
  if (state.tab === 'login') {
    if (Auth.isAdmin()) { state.tab = 'portal'; }   // déjà connecté
    else return Admin.renderGlobalLogin(app);
  }

  if (state.tab === 'portal') return Portal.render(app);

  if (state.tab === 'op') return OpenPlatine.render(app);
  if (state.tab === 'rc') return RadioCampus.render(app);
  if (state.tab === 'ev') return Events.render(app);
}

// MODE ADMIN GLOBAL : positionne la vue de départ d'un module selon l'état
// admin. Appelé UNIQUEMENT sur changement d'onglet ou changement d'auth, et
// jamais depuis render() : sinon un DJ qui ouvre un formulaire verrait sa
// vue réinitialisée à chaque re-render.
//
// Rappel : ceci ne fait qu'AFFICHER. L'autorisation réelle est appliquée par
// les policies Postgres via is_admin() (supabase/restrict-admin-emails.sql).
function syncModuleViews(){
  const admin = window.Auth && Auth.isAdmin();
  const start = admin ? 'admin' : 'cal';
  if (window.OpenPlatine) OpenPlatine.view = start;
  if (window.RadioCampus) RadioCampus.view = start;
  if (window.Events)      Events.view      = start;
}

// Ré-render quand l'état d'auth change (connexion / déconnexion admin).
// On resynchronise les vues : une déconnexion doit ramener les modules en
// vue publique, une connexion les passer en dashboard.
function onAuthChanged(){ syncModuleViews(); render(); }
window.onAuthChanged = onAuthChanged;

// Bannière si le backend n'est pas configuré (placeholders dans config.js).
function warnBannerIfNeeded(){
  if (window.CONFIG && window.CONFIG.isConfigured) return;
  if (document.getElementById('storageBanner')) return;
  const b = document.createElement('div');
  b.id = 'storageBanner';
  b.className = 'banner-warn';
  b.textContent = 'BACKEND NON CONFIGURÉ — renseigne supabaseUrl et supabaseAnonKey dans public/js/config.js. Sans ça, les réservations ne sont pas enregistrées.';
  document.body.insertBefore(b, document.body.firstChild);
}

// =====================================================================
// BOOT
// =====================================================================
(async function boot(){
  warnBannerIfNeeded();
  if (window.Auth && typeof Auth.init === 'function') {
    try { await Auth.init(); } catch (e) { console.warn('[auth] init:', e); }
  }
  setAccent('portal');
  // Une session admin peut déjà exister (persistSession, ou retour de
  // redirection Google) : les modules doivent démarrer dans la bonne vue.
  syncModuleViews();
  render();
})();

window.go = go;
window.render = render;
window.syncModuleViews = syncModuleViews;
