// =====================================================================
// ROUTER — état global + navigation par onglets + boot
// =====================================================================
// Single-page : un seul scope de données, navigation par onglets (pas de
// rechargement). Chargé EN DERNIER (après les modules) ; appelle render().
// =====================================================================

const state = {
  tab: 'portal',   // portal | op | rc | ev
};

function setAccent(tab){
  document.documentElement.style.setProperty('--accent', MODULE_ACCENT[tab] || 'var(--op)');
}

function go(tab){
  state.tab = tab;
  setAccent(tab);
  document.querySelectorAll('#mainTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function render(){
  const app = document.getElementById('app');
  if (state.tab === 'portal') return Portal.render(app);
  if (state.tab === 'op') return OpenPlatine.render(app);
  if (state.tab === 'rc') return RadioCampus.render(app);
  if (state.tab === 'ev') return Events.render(app);
}

// Ré-render quand l'état d'auth change (connexion / déconnexion admin).
function onAuthChanged(){ render(); }
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
  render();
})();

window.go = go;
window.render = render;
