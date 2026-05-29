// =====================================================================
// MODULE OPEN PLATINE
// Mercredis, créneaux 19h30-02h00, durées 1h-4h, détection de
// chevauchement, statuts attente/validé/refusé, blocage dès l'inscription.
// Données : OpStore (clé cb:op:YYYY-MM-DD -> { slots: { id: {...} } }).
// =====================================================================

const OpenPlatine = {
  HORAIRES: ['19:30','20:00','20:30','21:00','21:30','22:00','22:30','23:00','23:30','00:00','00:30','01:00','01:30','02:00'],
  DUREES: ['1h','2h','3h','4h'],
  DUREE_MIN: {'1h':60,'2h':120,'3h':180,'4h':240},
  START: timeToMin('19:30'),
  END: timeToMin('02:00'),

  view: 'cal',          // cal | form | ok | login | admin
  months: [],
  selMonth: 0,
  selDate: null,
  cache: {},            // dateKey -> { slots }
  form: {},

  emptyForm(){ return { nom:'', email:'', tel:'', instagram:'', styles:'', remarques:'', debut:'', duree:'' }; },

  // --- data ---
  slotsOf(dateKey){ return Object.values(this.cache[dateKey]?.slots || {}); },
  blockedOf(dateKey){ return this.slotsOf(dateKey).filter(s => s.status !== 'refused'); },

  async loadDate(d){
    const dateKey = dk(d);
    this.cache[dateKey] = await OpStore.getDate(dateKey);
    return this.cache[dateKey];
  },

  hasConflict(dateKey, debut, duree){
    const s = timeToMin(debut), e = s + (this.DUREE_MIN[duree] || 60);
    return this.blockedOf(dateKey).some(c => {
      const cs = timeToMin(c.debut), ce = cs + (this.DUREE_MIN[c.duree] || 60);
      return s < ce && e > cs;
    });
  },
  availableStarts(dateKey){
    const blocked = this.blockedOf(dateKey);
    return this.HORAIRES.filter(h => this.DUREES.some(du => {
      const s = timeToMin(h), e = s + this.DUREE_MIN[du];
      if (e > this.END) return false;
      return !blocked.some(c => { const cs = timeToMin(c.debut), ce = cs + (this.DUREE_MIN[c.duree] || 60); return s < ce && e > cs; });
    }));
  },

  buildMonths(){
    const now = new Date();
    // horizon glissant : jusqu'à fin de l'année prochaine (ne se fige pas dans le temps)
    const endYear = now.getFullYear() + 1;
    const today = todayMidnight();
    let firstWed = new Date(today);
    const diff = (3 - today.getDay() + 7) % 7;
    firstWed.setDate(today.getDate() + diff);
    if (diff === 0 && now.getHours() >= 18) firstWed.setDate(firstWed.getDate() + 7);

    const months = [];
    let y = firstWed.getFullYear(), m = firstWed.getMonth();
    while (y < endYear || (y === endYear && m <= 11)){
      const weds = [];
      const last = new Date(y, m+1, 0).getDate();
      const firstDow = new Date(y, m, 1).getDay();
      const firstWedDate = 1 + ((3 - firstDow + 7) % 7);
      for (let dd = firstWedDate; dd <= last; dd += 7){
        const w = new Date(y, m, dd);
        if (w >= firstWed) weds.push(w);
      }
      if (weds.length) months.push({ y, m, weds });
      m++; if (m > 11){ m = 0; y++; }
    }
    this.months = months;
  },

  // --- render ---
  async render(app){
    if (!this.months.length){
      this.buildMonths();
      const now = new Date();
      const idx = this.months.findIndex(mm => mm.y === now.getFullYear() && mm.m === now.getMonth());
      this.selMonth = idx >= 0 ? idx : 0;
    }
    if (this.view === 'cal') return this.renderCal(app);
    if (this.view === 'form') return this.renderForm(app);
    if (this.view === 'ok') return this.renderOk(app);
    if (this.view === 'login') return this.renderLogin(app);
    if (this.view === 'admin') return this.renderAdmin(app);
  },

  async renderCal(app){
    app.innerHTML = `
      <section>
        <div class="eyebrow">Soirée du mercredi · 19h30 – 02h00</div>
        <h1 class="title">Open<br><em>Platine</em></h1>
        <p class="lead">Réserve ton créneau, branche ta clé, joue ton set. Premier arrivé, premier servi. Validation par l'équipe.</p>
      </section>
      <div class="section-head"><h2 class="section-title">Choisis ta date</h2>
        <div class="section-meta"><button class="btn-mini" onclick="OpenPlatine.toLogin()">Espace admin</button></div></div>
      <div class="month-selector" id="opMonths"></div>
      <div class="legend">
        <div class="item"><span class="sw" style="background:var(--pending)"></span>En attente</div>
        <div class="item"><span class="sw" style="background:var(--ok)"></span>Validé</div>
        <div class="item"><span class="sw" style="background:var(--bg-3);border:1px solid var(--muted)"></span>Libre</div>
      </div>
      <div id="opList"><div class="portal-empty">Chargement…</div></div>
    `;
    this.renderMonths();
    await this.renderList();
  },

  renderMonths(){
    const c = document.getElementById('opMonths');
    if (!c) return;
    c.innerHTML = this.months.map((mm, i) =>
      `<div class="month-pill ${i === this.selMonth ? 'active' : ''}" onclick="OpenPlatine.selectMonth(${i})">${MONTHS_SHORT[mm.m]}</div>`
    ).join('');
  },

  async selectMonth(i){
    this.selMonth = i;
    this.renderMonths();
    await this.renderList();
  },

  async renderList(){
    const weds = this.months[this.selMonth].weds;
    // Liste les clés existantes (évite un get sur chaque mercredi libre)
    const existing = new Set(await OpStore.listDateKeys());
    await Promise.all(weds.map(w => {
      const k = dk(w);
      if (existing.has(k)) return this.loadDate(w);
      this.cache[k] = { slots:{} };           // date connue vide, pas d'appel réseau
      return Promise.resolve();
    }));
    const list = document.getElementById('opList');
    if (!list) return;
    list.innerHTML = weds.map(w => this.cardHtml(w)).join('');
  },

  cardHtml(date){
    const dateKey = dk(date);
    const past = isPast(date);
    const blocked = this.blockedOf(dateKey).sort((a,b) => timeToMin(a.debut) - timeToMin(b.debut));
    const avail = !past && this.availableStarts(dateKey).length > 0;
    return `
      <div class="op-card ${past ? 'past' : ''}">
        <div class="op-card-head">
          <div class="op-date"><span>MER</span>${date.getDate()} ${MONTHS[date.getMonth()]}</div>
          ${past ? '' : (avail
            ? `<button class="btn-mini" style="border-color:var(--accent);color:var(--accent)" onclick="OpenPlatine.openForm('${dateKey}')">Réserver un set</button>`
            : `<span class="section-meta">COMPLET</span>`)}
        </div>
        ${this.timelineHtml(this.slotsOf(dateKey))}
        ${blocked.length ? `<div class="op-slot-list">${blocked.map(s => `
          <div class="op-slot-line">
            <span class="t" style="color:${s.status === 'validated' ? 'var(--ok)' : 'var(--pending)'}">${escapeHtml(s.debut)} · ${escapeHtml(s.duree)}</span>
            <span class="n">${escapeHtml(s.nom)}</span>
            <span class="s">${escapeHtml(s.styles || '')}</span>
          </div>`).join('')}</div>`
          : (past ? '' : `<div class="section-meta" style="margin-top:10px">Soirée libre — sois le premier</div>`)}
      </div>`;
  },

  timelineHtml(slots){
    const total = this.END - this.START;
    const blocks = slots.map(s => {
      const start = timeToMin(s.debut), dur = this.DUREE_MIN[s.duree] || 60;
      const left = ((start - this.START) / total) * 100;
      const width = (dur / total) * 100;
      const color = s.status === 'refused' ? 'var(--refused)' : s.status === 'validated' ? 'var(--ok)' : 'var(--pending)';
      return `<div class="slot-block" style="left:${left}%;width:${width}%;background:${color}"><span>${escapeHtml(s.nom)}</span></div>`;
    }).join('');
    const marks = ['20:00','22:00','00:00','02:00'].map(h => {
      const left = ((timeToMin(h) - this.START) / total) * 100;
      return `<div class="hour-mark" style="left:${left}%"><span>${h.slice(0,2)}h</span></div>`;
    }).join('');
    return `<div class="timeline">${blocks}${marks}</div>`;
  },

  async openForm(dateKey){
    this.selDate = parseDk(dateKey);
    await this.loadDate(this.selDate);     // relecture fraîche avant d'ouvrir
    this.form = this.emptyForm();
    this.view = 'form';
    this.render(document.getElementById('app'));
  },

  renderForm(app){
    const d = this.selDate, dateKey = dk(d);
    const f = this.form;
    const fields = [
      ['nom','NOM DU DJ *','Ton nom de scène'],
      ['email','EMAIL *','contact@email.com'],
      ['tel','TÉLÉPHONE *','06 xx xx xx xx'],
      ['instagram','INSTAGRAM *','@tonpseudo'],
      ['styles','STYLES MUSICAUX *','House, Techno, Jungle…'],
      ['remarques','REMARQUES','Infos complémentaires…'],
    ];
    app.innerHTML = `
      <button class="btn-back" onclick="OpenPlatine.back()">← Retour aux mercredis</button>
      <div class="eyebrow">Inscription Open Platine</div>
      <h2 class="section-title" style="font-size:26px;margin-bottom:4px">Mercredi ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</h2>
      <div class="section-meta" style="color:var(--accent);margin-bottom:20px">CITIZEN BAR · 19H30 – 02H00</div>
      <div class="field"><label>Créneaux déjà pris</label>${this.timelineHtml(this.slotsOf(dateKey))}</div>
      <div class="grid-2">
        <div class="field"><label>Heure de début *</label>
          <select id="op_debut">${['<option value="">Choisir…</option>'].concat(this.HORAIRES.map(h => `<option ${f.debut === h ? 'selected' : ''}>${h}</option>`)).join('')}</select></div>
        <div class="field"><label>Durée *</label>
          <select id="op_duree">${['<option value="">Choisir…</option>'].concat(this.DUREES.map(x => `<option ${f.duree === x ? 'selected' : ''}>${x}</option>`)).join('')}</select></div>
      </div>
      ${fields.map(([k,l,p]) => `<div class="field"><label>${l}</label><input id="op_${k}" value="${escapeHtml(f[k])}" placeholder="${p}"></div>`).join('')}
      <div id="op_err"></div>
      <button class="btn" onclick="OpenPlatine.submit()">Envoyer mon inscription</button>
    `;
  },

  readForm(){
    const g = id => (document.getElementById(id)?.value || '').trim();
    return { nom:g('op_nom'), email:g('op_email'), tel:g('op_tel'), instagram:g('op_instagram'),
      styles:g('op_styles'), remarques:g('op_remarques'), debut:g('op_debut'), duree:g('op_duree') };
  },

  async submit(){
    if (this._submitting) return;            // anti double-clic
    const f = this.readForm(); this.form = f;
    const err = document.getElementById('op_err');
    const btn = document.querySelector('#app .btn');
    if (!f.nom || !f.email || !f.tel || !f.instagram || !f.styles || !f.debut || !f.duree){
      err.innerHTML = '<div class="error">Merci de remplir tous les champs obligatoires (*).</div>'; return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)){
      err.innerHTML = '<div class="error">Email invalide.</div>'; return;
    }
    const dateKey = dk(this.selDate);
    // pré-check UX (le serveur reste l'autorité via la contrainte d'exclusion)
    await this.loadDate(this.selDate);
    if (this.hasConflict(dateKey, f.debut, f.duree)){
      err.innerHTML = '<div class="error">Ce créneau chevauche une réservation existante. Choisis un autre horaire.</div>';
      return;
    }
    this._submitting = true; if (btn){ btn.disabled = true; btn.textContent = 'Envoi…'; }
    const res = await OpStore.request(dateKey, f);
    this._submitting = false;
    if (!res.ok){
      if (btn){ btn.disabled = false; btn.textContent = 'Envoyer mon inscription'; }
      err.innerHTML =
        res.reason === 'overlap' ? '<div class="error">Trop tard, ce créneau vient d\'être pris. Choisis un autre horaire.</div>'
        : res.reason === 'config' ? '<div class="error">Backend non configuré (Supabase). Vérifie supabaseUrl et supabaseAnonKey dans config.js.</div>'
        : `<div class="error">Échec de l'enregistrement.<br>Détail : ${escapeHtml(LAST_STORAGE_ERROR || 'inconnu')}</div>`;
      return;
    }
    this.view = 'ok';
    this.render(document.getElementById('app'));
  },

  renderOk(app){
    app.innerHTML = `
      <div class="success">
        <div class="eyebrow" style="justify-content:center">Inscription reçue</div>
        <h2>En attente de validation</h2>
        <p>Ton créneau est réservé. L'équipe du Citizen Bar revient vers toi pour confirmer.</p>
        <button class="btn" style="max-width:280px;margin:0 auto" onclick="OpenPlatine.back()">Retour aux mercredis</button>
      </div>`;
  },

  back(){ this.view = 'cal'; this.render(document.getElementById('app')); },

  // --- admin ---
  toLogin(){
    if (Auth.isAdmin()){ this.view = 'admin'; } else { this.view = 'login'; }
    this.render(document.getElementById('app'));
  },
  renderLogin(app){ Admin.renderLogin(app, 'OpenPlatine'); },
  async login(){ return Admin.login('OpenPlatine'); },

  async renderAdmin(app){
    app.innerHTML = `
      <div class="eyebrow">Administration</div>
      <h2 class="title" style="font-size:clamp(36px,7vw,64px)">Dashboard <em>Open Platine</em></h2>
      <div class="section-head"><h2 class="section-title">Inscriptions</h2>
        <div class="section-meta">
          <button class="btn-mini" onclick="OpenPlatine.loadAdmin()">↻ Rafraîchir</button>
          <button class="btn-mini" onclick="OpenPlatine.back()">Vue publique</button>
          <button class="btn-mini" onclick="Admin.signOut('OpenPlatine')">Déconnexion</button>
        </div></div>
      <div id="op_admin"><div class="portal-empty">Chargement…</div></div>`;
    this.loadAdmin();
  },

  async loadAdmin(){
    const dateKeys = (await OpStore.listDateKeys()).sort();
    // charge les dates en parallèle
    const datas = await Promise.all(dateKeys.map(k => OpStore.getDate(k)));
    const groups = [];
    dateKeys.forEach((dateKey, i) => {
      const data = datas[i]; if (!data) return;
      this.cache[dateKey] = data;
      const slots = Object.entries(data.slots || {});
      if (!slots.length) return;
      groups.push({ dateKey, date: parseDk(dateKey), slots });
    });
    // enrichit chaque slot de ses contacts (table privée), en parallèle
    const flat = groups.flatMap(g => g.slots.map(([id, s]) => ({ id, s })));
    const contacts = await Promise.all(flat.map(x => OpStore.contact(x.id)));
    flat.forEach((x, i) => { const c = contacts[i] || {}; x.s.email = c.email; x.s.tel = c.tel; x.s.instagram = c.instagram; x.s.remarques = c.remarques; });
    const all = groups.flatMap(g => g.slots.map(([,s]) => s));
    const count = st => all.filter(s => s.status === st).length;
    const target = document.getElementById('op_admin');
    if (!target) return;

    const today = todayMidnight();
    const upcoming = groups.filter(g => g.date >= today).sort((a,b) => a.date - b.date);
    const past = groups.filter(g => g.date < today).sort((a,b) => b.date - a.date);

    const stats = `<div class="admin-stats">
      <div class="stat" style="--st-c:var(--pending)"><div class="v">${count('pending')}</div><div class="l">En attente</div></div>
      <div class="stat" style="--st-c:var(--ok)"><div class="v">${count('validated')}</div><div class="l">Validés</div></div>
      <div class="stat" style="--st-c:var(--refused)"><div class="v">${count('refused')}</div><div class="l">Refusés</div></div>
    </div>`;

    if (!all.length){ target.innerHTML = stats + `<div class="portal-empty">Aucune inscription.</div>`; return; }
    target.innerHTML = stats + this.groupsHtml(upcoming, false) + this.groupsHtml(past, true);
  },

  groupsHtml(groups, isPastGroup){
    if (!groups.length) return '';
    const label = isPastGroup ? 'Passé' : 'À venir';
    return `<div class="admin-group"><div class="admin-group-title">${label}</div>` + groups.map(g => {
      const slots = g.slots.sort(([,a],[,b]) => timeToMin(a.debut) - timeToMin(b.debut));
      return `<div style="margin-bottom:16px${isPastGroup ? ';opacity:0.6' : ''}">
        <div class="section-meta" style="color:var(--accent);font-weight:700;margin-bottom:8px">MERCREDI ${g.date.getDate()} ${MONTHS[g.date.getMonth()]} ${g.date.getFullYear()}</div>
        ${slots.map(([id,s]) => this.bookingCard(g.dateKey, id, s, isPastGroup)).join('')}
      </div>`;
    }).join('') + `</div>`;
  },

  bookingCard(dateKey, id, s, isPastCard){
    const bc = s.status === 'validated' ? 'var(--ok)' : s.status === 'refused' ? 'var(--refused)' : 'var(--pending)';
    const meta = [['email',s.email],['tél',s.tel],['instagram',s.instagram],['styles',s.styles], s.remarques && ['remarques',s.remarques]].filter(Boolean);
    return `<div class="booking-card" style="--bc:${bc}">
      <div class="bc-head">
        <div><div class="bc-name">${escapeHtml(s.nom)}</div><div class="bc-sub">${escapeHtml(s.debut)} · ${escapeHtml(s.duree)}</div></div>
        <span class="pill ${s.status}">${s.status === 'validated' ? 'Validé' : s.status === 'refused' ? 'Refusé' : 'En attente'}</span>
      </div>
      <div class="bc-meta">${meta.map(([k,v]) => `<div><span class="k">${k}</span>${escapeHtml(v)}</div>`).join('')}</div>
      ${isPastCard ? '' : `<div class="bc-actions">
        ${s.status !== 'validated' ? `<button class="btn-mini green" onclick="OpenPlatine.setStatus('${dateKey}','${id}','validated')">Valider</button>` : ''}
        ${s.status !== 'refused' ? `<button class="btn-mini red" onclick="OpenPlatine.setStatus('${dateKey}','${id}','refused')">Refuser</button>` : ''}
        ${s.status === 'refused' ? `<button class="btn-mini" onclick="OpenPlatine.setStatus('${dateKey}','${id}','pending')">Remettre en attente</button>` : ''}
      </div>`}
    </div>`;
  },

  async setStatus(dateKey, id, status){
    if (!Auth.isAdmin()) return;
    const ok = await OpStore.setStatus(id, status);
    if (ok) this.loadAdmin();
  }
};

window.OpenPlatine = OpenPlatine;
