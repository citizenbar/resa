// =====================================================================
// AUTH — administration via Supabase Auth (email / mot de passe)
// =====================================================================
// Le compte admin se crée dans Supabase (Authentication → Users → Add user).
// Aucun secret côté client : les RLS (policies.sql) restreignent les écritures
// sensibles (validate/refuse/delete) aux utilisateurs authentifiés.
//
// Sécurité poste partagé (bar) : déconnexion automatique après inactivité.
// =====================================================================

const Auth = {
  session: null,
  IDLE_MS: 30 * 60 * 1000,   // 30 min d'inactivité -> logout auto
  _idleTimer: null,

  isAdmin(){ return !!this.session; },

  // Boot : récupère la session existante + écoute les changements.
  async init(){
    if (!window.sb) return null;
    try {
      const { data } = await window.sb.auth.getSession();
      this.session = (data && data.session) || null;
      window.sb.auth.onAuthStateChange((_event, session) => {
        this.session = session || null;
        if (this.session) this._armIdle(); else this._disarmIdle();
        if (typeof onAuthChanged === 'function') onAuthChanged();
      });
      if (this.session) this._armIdle();
    } catch (e) {
      console.warn('[auth] init:', e);
    }
    return this.session;
  },

  // Connexion admin. Retour : { ok:true } | { ok:false, error:'...' }
  async signIn(email, password){
    if (!window.sb) return { ok:false, error:'Backend non configuré (Supabase).' };
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) return { ok:false, error: this._frError(error) };
    this.session = data.session;
    this._armIdle();
    return { ok:true };
  },

  async signOut(){
    if (window.sb) { try { await window.sb.auth.signOut(); } catch (e) {} }
    this.session = null;
    this._disarmIdle();
  },

  // --- inactivité ---
  _armIdle(){
    this._disarmIdle();
    const reset = () => this._armIdle();
    this._idleEvents = ['click','keydown','touchstart'];
    this._idleReset = reset;
    this._idleEvents.forEach(ev => document.addEventListener(ev, reset, { passive:true, once:true }));
    this._idleTimer = setTimeout(async () => {
      await this.signOut();
      if (typeof onAuthChanged === 'function') onAuthChanged();
    }, this.IDLE_MS);
  },
  _disarmIdle(){
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._idleEvents && this._idleReset) {
      this._idleEvents.forEach(ev => document.removeEventListener(ev, this._idleReset));
    }
  },

  _frError(error){
    const m = (error && error.message) || '';
    if (/invalid login credentials/i.test(m)) return 'Email ou mot de passe incorrect.';
    if (/email not confirmed/i.test(m)) return 'Email non confirmé. Vérifie ta boîte mail.';
    return m || 'Connexion impossible.';
  },
};

window.Auth = Auth;
