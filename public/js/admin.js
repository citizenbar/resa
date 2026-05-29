// =====================================================================
// ADMIN — login / logout partagés (Supabase Auth)
// =====================================================================
// Les trois modules (OpenPlatine / RadioCampus / Events) partagent le même
// écran de connexion et la même session. Une fois connecté, l'admin a accès
// aux dashboards des trois modules (Auth.isAdmin()).
//
// Chaque module délègue ici :
//   - renderLogin(app, moduleName) : affiche le formulaire email/mot de passe
//   - login(moduleName)            : tente la connexion, route vers 'admin'
//   - signOut(moduleName)          : déconnexion, retour vue publique
//
// moduleName = 'OpenPlatine' | 'RadioCampus' | 'Events' (clé window.<module>).
// =====================================================================

const Admin = {
  renderLogin(app, moduleName){
    app.innerHTML = `
      <div class="admin-login">
        <div class="eyebrow" style="justify-content:center">Accès réservé</div>
        <h2 class="section-title" style="font-size:24px;margin-bottom:18px">Dashboard admin</h2>
        <div class="field"><input type="email" id="admin_email" placeholder="Email admin" autocomplete="username"
          onkeydown="if(event.key==='Enter')document.getElementById('admin_pwd').focus()"></div>
        <div class="field"><input type="password" id="admin_pwd" placeholder="Mot de passe" autocomplete="current-password"
          onkeydown="if(event.key==='Enter')${moduleName}.login()"></div>
        <div id="admin_login_err"></div>
        <button class="btn" onclick="${moduleName}.login()">Entrer</button>
        <button class="btn-mini" style="margin-top:10px;border:none;color:var(--fg-dim)" onclick="${moduleName}.back()">← Retour</button>
      </div>`;
    setTimeout(() => document.getElementById('admin_email')?.focus(), 40);
  },

  async login(moduleName){
    const mod = window[moduleName];
    const email = (document.getElementById('admin_email')?.value || '').trim();
    const password = (document.getElementById('admin_pwd')?.value || '').trim();
    const err = document.getElementById('admin_login_err');
    if (!email || !password){
      if (err) err.innerHTML = '<div class="error">Renseigne ton email et ton mot de passe.</div>';
      return;
    }
    const res = await Auth.signIn(email, password);
    if (!res.ok){
      if (err) err.innerHTML = `<div class="error">${escapeHtml(res.error || 'Connexion impossible.')}</div>`;
      return;
    }
    mod.view = 'admin';
    mod.render(document.getElementById('app'));
  },

  async signOut(moduleName){
    const mod = window[moduleName];
    await Auth.signOut();
    mod.view = 'cal';
    mod.render(document.getElementById('app'));
  },
};

window.Admin = Admin;
