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
  isAdminUser: false,        // l'email de la session est-il dans la liste blanche ?
  IDLE_MS: 30 * 60 * 1000,   // 30 min d'inactivité -> logout auto
  _idleTimer: null,

  // ATTENTION : être connecté ne suffit PAS à être admin.
  // Depuis l'activation de « Sign in with Google », n'importe qui peut obtenir
  // une session (Supabase crée le compte à la première connexion). L'autorité
  // est la liste blanche admin_emails, vérifiée côté serveur par la fonction
  // is_admin() (supabase/restrict-admin-emails.sql) sur laquelle reposent
  // toutes les policies RLS.
  // Ce booléen ne sert qu'à l'AFFICHAGE (ne pas montrer un dashboard vide à un
  // visiteur) : il est piloté par le serveur, jamais par une liste en dur ici.
  isAdmin(){ return !!this.session && this.isAdminUser; },

  // Interroge le serveur : l'utilisateur courant est-il dans la liste blanche ?
  async _refreshAdminFlag(){
    if (!this.session || !window.sb) { this.isAdminUser = false; return; }
    try {
      const { data, error } = await window.sb.rpc('is_admin');
      this.isAdminUser = !error && data === true;
    } catch (e) {
      this.isAdminUser = false;
    }
  },

  // Boot : récupère la session existante + écoute les changements.
  async init(){
    if (!window.sb) return null;
    try {
      const { data } = await window.sb.auth.getSession();
      this.session = (data && data.session) || null;
      await this._refreshAdminFlag();
      window.sb.auth.onAuthStateChange(async (_event, session) => {
        this.session = session || null;
        await this._refreshAdminFlag();
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
    await this._refreshAdminFlag();
    this._armIdle();
    if (!this.isAdminUser) {
      // Session valide mais compte hors liste blanche : on la ferme tout de
      // suite plutôt que de laisser un utilisateur connecté sans droits.
      await this.signOut();
      return { ok:false, error: this._notAllowedMsg(email) };
    }
    return { ok:true };
  },

  // Connexion Google (OAuth). Redirige vers Google puis revient sur le site ;
  // le retour est traité par onAuthStateChange (detectSessionInUrl est actif
  // dans supabase-client.js), qui rafraîchit le drapeau admin.
  // N'IMPORTE QUEL compte Google peut obtenir une session : c'est is_admin()
  // côté serveur qui décide des droits réels.
  async signInWithGoogle(){
    if (!window.sb) return { ok:false, error:'Backend non configuré (Supabase).' };
    const { error } = await window.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) return { ok:false, error: this._frError(error) };
    return { ok:true };   // la page redirige ; la suite se joue au retour
  },

  _notAllowedMsg(email){
    return 'Ce compte' + (email ? ' (' + email + ')' : '') +
      " n'est pas autorisé à administrer les réservations.";
  },

  async signOut(){
    if (window.sb) { try { await window.sb.auth.signOut(); } catch (e) {} }
    this.session = null;
    this.isAdminUser = false;
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
