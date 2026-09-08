// =====================================================================
// ADMIN : mode admin global (« god mode »)
// =====================================================================
// Un seul point d'entrée pour toute l'application : le bouton ⚡ du header.
// Une fois connecté, les onglets Open Platine / Radio Campus / Events
// affichent leur dashboard au lieu de leur vue publique (arbitrage dans
// router.js via syncModuleViews), et un bandeau rappelle qui est connecté.
//
// Connexion : Google uniquement. Le formulaire email/mot de passe a été
// retiré pour n'avoir qu'un seul parcours à maintenir.
//
// IMPORTANT : tout ce fichier ne fait qu'AFFICHER. L'autorisation réelle
// est appliquée côté serveur par les policies Postgres via is_admin()
// (supabase/restrict-admin-emails.sql), qui n'autorise que les emails de
// la table admin_emails. Un utilisateur qui contournerait cette UI
// n'obtiendrait aucune donnée.
// =====================================================================

const Admin = {
  // =====================================================================
  // MODE ADMIN GLOBAL (« god mode »)
  // =====================================================================
  // Avant : chaque module portait son propre écran de login et son propre
  // état (view: 'login' | 'admin'), donc trois portes d'entrée et un mode
  // admin perdu à chaque changement d'onglet — alors que la SESSION, elle,
  // est globale et commune aux trois modules.
  //
  // Maintenant : un seul interrupteur. Une fois connecté, les onglets
  // existants (Open Platine / Radio Campus / Events) affichent leur
  // dashboard au lieu de leur vue publique. C'est router.js qui arbitre,
  // via Auth.isAdmin(). Les modules n'ont plus à gérer 'login'.

  // Bouton du header : ⚡ discret pour se connecter, actif une fois admin.
  renderHeaderButton(){
    const b = document.getElementById('adminEntry');
    if (!b) return;
    const on = Auth.isAdmin();
    b.classList.toggle('active', on);
    b.textContent = on ? '⚡ ADMIN' : '⚡';
    b.title = on ? 'Mode admin actif' : 'Espace admin';
  },

  // Bandeau permanent en mode admin : rappelle QUI est connecté (poste
  // partagé au bar) et donne la déconnexion à portée de clic.
  renderBanner(){
    const bar = document.getElementById('adminBar');
    if (!bar) return;
    if (!Auth.isAdmin()) { bar.innerHTML = ''; return; }
    const mail = (Auth.session && Auth.session.user && Auth.session.user.email) || '';
    bar.innerHTML = `
      <div class="admin-bar">
        <span class="admin-bar-tag">⚡ Mode admin</span>
        <span class="admin-bar-mail">${escapeHtml(mail)}</span>
        <button class="btn-mini" onclick="Admin.signOutGlobal()">Déconnexion</button>
      </div>`;
  },

  // Clic sur le ⚡ du header : connecté -> retour à l'agenda ; sinon login.
  // On passe par go() plutôt que d'écrire dans `state` depuis ce fichier :
  // l'état de navigation appartient à router.js.
  headerClick(){
    go(Auth.isAdmin() ? 'portal' : 'login');
  },

  // Déconnexion globale : on quitte le mode admin et on revient au public.
  async signOutGlobal(){
    await Auth.signOut();
    go('portal');
  },

  // Écran de connexion global. Google est le SEUL chemin : le formulaire
  // email/mot de passe a été retiré volontairement (un seul parcours à
  // maintenir, et le compte admin n'a pas de mot de passe à gérer).
  // NB : les comptes restent créés dans Supabase ; c'est la liste blanche
  // admin_emails qui autorise, pas le fournisseur.
  renderGlobalLogin(app){
    app.innerHTML = `
      <div class="admin-login">
        <div class="eyebrow" style="justify-content:center">Accès réservé</div>
        <h2 class="section-title" style="font-size:24px;margin-bottom:18px">Espace admin</h2>
        <div id="admin_login_err"></div>
        <button class="btn btn-google" onclick="Admin.loginGoogle()">Continuer avec Google</button>
        <button class="btn-mini" style="margin-top:10px;border:none;color:var(--fg-dim)" onclick="go('portal')">← Retour au site</button>
      </div>`;
    // Retour de redirection Google avec un compte hors liste blanche : la
    // session existe mais n'ouvre aucun droit. On le dit, puis on la ferme.
    if (Auth.session && !Auth.isAdminUser) {
      const err = document.getElementById('admin_login_err');
      const mail = Auth.session.user && Auth.session.user.email;
      if (err) err.innerHTML = `<div class="error">${escapeHtml(Auth._notAllowedMsg(mail))}</div>`;
      Auth.signOut();
    }
  },

  // Connexion Google. Redirige vers Google ; le retour est traité par
  // onAuthStateChange (detectSessionInUrl actif), qui rafraîchit le drapeau
  // admin puis re-render.
  async loginGoogle(){
    const err = document.getElementById('admin_login_err');
    const res = await Auth.signInWithGoogle();
    if (!res.ok && err) {
      err.innerHTML = `<div class="error">${escapeHtml(res.error || 'Connexion Google impossible.')}</div>`;
    }
  },
};

window.Admin = Admin;
