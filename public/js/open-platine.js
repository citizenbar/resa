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

  view: 'cal',          // cal | form | ok | admin (piloté par router.js)
  lastRef: null,        // uuid de la dernière demande, pour la référence affichée
  occ: {},              // dateKey -> [{debut,duree,status}] (vue op_occupancy)
  months: [],
  selMonth: 0,
  selDate: null,
  cache: {},            // dateKey -> { slots }
  form: {},

  emptyForm(){ return { nom:'', email:'', tel:'', instagram:'', styles:'', remarques:'', debut:'', duree:'', photo:'' }; },

  // --- data ---
  slotsOf(dateKey){ return Object.values(this.cache[dateKey]?.slots || {}); },

  // Plages OCCUPÉES d'une date, en fusionnant deux sources :
  //   1. this.cache : les lignes que la RLS laisse voir (validées, ou tout
  //      si l'admin est connecté). Elles portent le nom du DJ.
  //   2. this.occ   : la vue publique op_occupancy, qui expose AUSSI les
  //      créneaux 'pending' — invisibles autrement pour un visiteur.
  //
  // Sans (2), un créneau en attente n'apparaissait pas dans la timeline :
  // le DJ voyait la plage libre, remplissait le formulaire, et se faisait
  // refuser à l'envoi (« chevauchement »). Même bug UX que Radio Campus.
  //
  // La déduplication se fait sur (debut, duree) : une ligne visible dans le
  // cache est forcément présente dans l'occupation, il ne faut pas la
  // compter deux fois (elle s'afficherait en double sur la timeline).
  blockedOf(dateKey){
    const fromCache = this.slotsOf(dateKey).filter(s => s.status !== 'refused');
    const seen = new Set(fromCache.map(s => s.debut + '|' + s.duree));
    const extra = (this.occ[dateKey] || [])
      .filter(o => !seen.has(o.debut + '|' + o.duree))
      // pas de nom : ces créneaux ne sont pas lisibles publiquement
      .map(o => ({ debut: o.debut, duree: o.duree, status: o.status, nom: '', anonyme: true }));
    return fromCache.concat(extra);
  },

  // Vrai si la date porte au moins un créneau en attente non visible
  // publiquement : sert à afficher l'avertissement avant la saisie.
  hasPendingOn(dateKey){
    return (this.occ[dateKey] || []).some(o => o.status === 'pending');
  },

  async loadDate(d){
    const dateKey = dk(d);
    this.cache[dateKey] = await OpStore.getDate(dateKey);
    return this.cache[dateKey];
  },

  // Vrai si au moins un champ du formulaire a été saisi.
  hasInput(){
    const f = this.form || {};
    return Object.keys(this.emptyForm()).some(k => String(f[k] || '').trim() !== '');
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
    if (this.view === 'admin') return this.renderAdmin(app);
  },

  async renderCal(app){
    app.innerHTML = `
      <section>
        <div class="eyebrow">Soirée du mercredi · 19h30 – 02h00</div>
        <h1 class="title">Open<br><em>Platine</em></h1>
        <p class="lead">Réserve ton créneau, branche ta clé, joue ton set. Premier arrivé, premier servi. Validation par l'équipe.</p>
      </section>
      <!-- Matériel annoncé : « branche ta clé » laissait deviner l'installation
           sans jamais la décrire. Un DJ doit savoir ce qu'il trouve en arrivant,
           et surtout ce qu'il doit apporter (le casque). La Traktor Kontrol Z2
           est volontairement HORS de cette liste : l'annoncer ferait venir des
           DJ avec leur ordinateur sans prévenir. Elle reste disponible sur
           demande. -->
      <div class="gear">
        <div class="section-meta gear-title">CE QUI T'ATTEND EN RÉGIE</div>
        <ul class="gear-list">
          <li>2 platines vinyle Technics MK2</li>
          <li>2 Pioneer XDJ-1000 MK2 (lecture clé USB)</li>
          <li>Table de mixage Allen &amp; Heath Xone:43C</li>
        </ul>
        <div class="gear-note"><strong>Le casque n'est pas fourni</strong> : pense à apporter le tien.</div>
        <div class="gear-note">Autre configuration (contrôleur, ordinateur) : demande-nous avant, on en discute.</div>
      </div>
      <div class="section-head"><h2 class="section-title">Choisis ta date</h2>
        <div class="section-meta"></div></div>
      <div class="month-selector" id="opMonths"></div>
      <div class="legend">
        <div class="item"><span class="sw" style="background:var(--pending)"></span>En attente / demandé</div>
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
    // Occupation publique d'abord : elle seule contient les créneaux en
    // attente, que la RLS cache au visiteur (cf. blockedOf).
    this.occ = await OpStore.occupancy();
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
            <span class="n">${escapeHtml(s.anonyme ? 'Réservé' : s.nom)}</span>
            <span class="s">${escapeHtml(s.anonyme ? 'demande en cours' : (s.styles || ''))}</span>
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
      // Créneau connu par l'occupation publique seulement : on montre qu'il
      // est pris, sans nom (la RLS ne nous laisse pas le lire).
      const label = s.anonyme ? 'Réservé' : s.nom;
      return `<div class="slot-block" style="left:${left}%;width:${width}%;background:${color}"><span>${escapeHtml(label)}</span></div>`;
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
    this.occ = await OpStore.occupancy();  // + créneaux en attente (invisibles via RLS)
    // On ne vide le formulaire que s'il est vierge : après un conflit à
    // l'envoi, la saisie de l'utilisateur est conservée.
    if (!this.hasInput()) this.form = this.emptyForm();
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
      ${this.hasPendingOn(dateKey) ? `<div class="warn-banner">
        <strong>Une ou plusieurs demandes sont déjà en attente sur cette soirée.</strong>
        Les plages concernées apparaissent ci-dessous. Tu peux réserver un créneau libre :
        si tu chevauches une demande en cours, la tienne pourra être refusée.
      </div>` : ''}
      <div class="field"><label>Créneaux déjà pris</label>${this.timelineHtml(this.blockedOf(dateKey))}</div>
      <div class="grid-2">
        <div class="field"><label>Heure de début *</label>
          <select id="op_debut">${['<option value="">Choisir…</option>'].concat(this.HORAIRES.map(h => `<option ${f.debut === h ? 'selected' : ''}>${h}</option>`)).join('')}</select></div>
        <div class="field"><label>Durée *</label>
          <select id="op_duree">${['<option value="">Choisir…</option>'].concat(this.DUREES.map(x => `<option ${f.duree === x ? 'selected' : ''}>${x}</option>`)).join('')}</select></div>
      </div>
      ${fields.map(([k,l,p]) => `<div class="field"><label>${l}</label><input id="op_${k}" value="${escapeHtml(f[k])}" placeholder="${p}"></div>`).join('')}
      <div class="field">
        <label>PHOTO / VISUEL</label>
        <div class="section-meta" style="margin-bottom:6px">Facultatif, mais c'est ce qui nous permet de faire l'affiche. Téléverse une image (JPG, PNG ou WebP, 5 Mo max) OU colle un lien.</div>
        <input type="file" id="op_photo_file" accept="image/jpeg,image/png,image/webp" onchange="OpenPlatine.onPhotoPick()">
        <div id="op_photo_status" class="section-meta" style="margin-top:4px"></div>
        <div style="margin-top:8px"><input id="op_photo" value="${escapeHtml(f.photo || '')}" placeholder="…ou lien : Drive, Instagram, WeTransfer…"></div>
      </div>
      <div id="op_err"></div>
      <button class="btn" onclick="OpenPlatine.submit()">Envoyer mon inscription</button>
    `;
  },

  readForm(){
    const g = id => (document.getElementById(id)?.value || '').trim();
    return { nom:g('op_nom'), email:g('op_email'), tel:g('op_tel'), instagram:g('op_instagram'),
      styles:g('op_styles'), remarques:g('op_remarques'), debut:g('op_debut'), duree:g('op_duree'),
      photo:g('op_photo') };
  },

  // Choix d'un fichier : validation immédiate (type + taille) + retour visuel.
  // Un fichier valide vide le champ lien (les deux sont exclusifs, cf. Events).
  onPhotoPick(){
    const input = document.getElementById('op_photo_file');
    const status = document.getElementById('op_photo_status');
    const link = document.getElementById('op_photo');
    const file = input?.files?.[0];
    if (!file){ if (status) status.textContent = ''; return; }
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)){
      status.innerHTML = '<span style="color:var(--refused)">Format non supporté (JPG, PNG, WebP).</span>'; input.value = ''; return;
    }
    if (file.size > 5*1024*1024){
      status.innerHTML = '<span style="color:var(--refused)">Fichier trop lourd (5 Mo max).</span>'; input.value = ''; return;
    }
    status.innerHTML = `<span style="color:var(--ok)">✓ ${escapeHtml(file.name)} prêt à être envoyé.</span>`;
    if (link) link.value = '';
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
    const photoFile = document.getElementById('op_photo_file')?.files?.[0] || null;
    this._submitting = true; if (btn){ btn.disabled = true; btn.textContent = 'Envoi…'; }

    // Photo facultative. Si un fichier est fourni, on l'uploade d'abord : il
    // prime sur le lien. Pas de code ici (module ouvert), donc l'autorisation
    // serveur passe par le quota d'IP (upload-quota-2026-09.sql).
    if (photoFile){
      if (btn) btn.textContent = 'Envoi de la photo…';
      const up = await uploadArtistPhoto(null, photoFile);
      if (!up.ok){
        this._submitting = false;
        if (btn){ btn.disabled = false; btn.textContent = 'Envoyer mon inscription'; }
        err.innerHTML =
          up.reason === 'too_big'  ? '<div class="error">Photo trop lourde (5 Mo max).</div>'
          : up.reason === 'bad_type' ? '<div class="error">Format de photo non supporté (JPG, PNG, WebP).</div>'
          : up.reason === 'quota'    ? '<div class="error">Trop d\'envois depuis cette connexion. Réessaie dans une heure, ou colle un lien à la place.</div>'
          : '<div class="error">Échec de l\'envoi de la photo. Réessaie, ou colle un lien à la place.</div>';
        return;
      }
      f.photo = up.url;   // l'URL Storage remplace tout lien éventuel
      if (btn) btn.textContent = 'Envoi…';
    }

    const res = await OpStore.request(dateKey, f);
    this._submitting = false;
    if (!res.ok){
      if (btn){ btn.disabled = false; btn.textContent = 'Envoyer mon inscription'; }
      // Occupation rafraîchie : la plage qui vient d'être prise doit
      // apparaître dans la timeline du formulaire au prochain rendu.
      if (res.reason === 'overlap') this.occ = await OpStore.occupancy();
      err.innerHTML =
        res.reason === 'overlap' ? '<div class="error">Ce créneau vient d\'être pris. Ta saisie est conservée : choisis un autre horaire ci-dessus.</div>'
        : res.reason === 'config' ? '<div class="error">Backend non configuré (Supabase). Vérifie supabaseUrl et supabaseAnonKey dans config.js.</div>'
        : `<div class="error">Échec de l'enregistrement.<br>Détail : ${escapeHtml(LAST_STORAGE_ERROR || 'inconnu')}</div>`;
      return;
    }
    this.lastRef = res.id;   // reference a afficher sur l'ecran de confirmation
    this.form = this.emptyForm();   // succès : on repart d'un formulaire vierge
    this.view = 'ok';
    this.render(document.getElementById('app'));
  },

  renderOk(app){
    app.innerHTML = `
      <div class="success">
        <div class="eyebrow" style="justify-content:center">Inscription reçue</div>
        <h2>En attente de validation</h2>
        <p>Ton créneau est réservé. L'équipe du Citizen Bar revient vers toi pour confirmer.</p>
        ${refBlockHtml('op', this.lastRef)}
        <button class="btn" style="max-width:280px;margin:0 auto" onclick="OpenPlatine.back()">Retour aux mercredis</button>
      </div>`;
  },

  back(){ this.view = 'cal'; this.render(document.getElementById('app')); },

  // --- admin ---
  // La vue est pilotée par syncModuleViews() dans router.js : ce module n'a
  // plus d'écran de connexion propre (mode admin global).
  async renderAdmin(app){
    app.innerHTML = `
      <div class="eyebrow">Administration</div>
      <h2 class="title" style="font-size:clamp(36px,7vw,64px)">Dashboard <em>Open Platine</em></h2>
      <div class="section-head"><h2 class="section-title">Inscriptions</h2>
        <div class="section-meta">
          <button class="btn-mini" onclick="OpenPlatine.loadAdmin()">↻ Rafraîchir</button>
        </div></div>
      <div id="op_admin"><div class="portal-empty">Chargement…</div></div>`;
    this.loadAdmin();
  },

  async loadAdmin(){
    const dateKeys = (await OpStore.listDateKeys()).sort();
    // charge les dates en parallèle
    // getDateAdmin (et non getDate) : lit en plus les colonnes promo
    // (instagram, photo) portées par op_slots. Chemin séparé du public.
    const datas = await Promise.all(dateKeys.map(k => OpStore.getDateAdmin(k)));
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
    // op_contacts ne porte plus instagram (migrate-public-events.sql l'a déplacé
    // vers op_slots) : le lire ici renvoyait undefined. Il vient désormais de
    // getDateAdmin, avec la photo.
    flat.forEach((x, i) => { const c = contacts[i] || {}; x.s.email = c.email; x.s.tel = c.tel; x.s.remarques = c.remarques; });
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
    const meta = [['réf',refFromId('op', s.id)],['email',s.email],['tél',s.tel],s.instagram && ['instagram',s.instagram],['styles',s.styles], s.photo && ['photo',s.photo], s.remarques && ['remarques',s.remarques]].filter(Boolean);
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
        <button class="btn-mini" onclick="OpenPlatine.openEdit('${dateKey}','${id}')">Modifier</button>
      </div>`}
      <div id="op_edit_${id}"></div>
    </div>`;
  },

  // ÉDITION D'UNE FICHE (admin). Le bouton n'apparaît que sur les cartes à
  // venir : le CHECK op_not_past est revalidé à chaque écriture, une soirée
  // passée est de toute façon non modifiable côté base.
  // La DATE n'est pas éditable : la changer peut violer op_no_overlap et
  // revient à créer un autre créneau (supprimer puis recréer).
  openEdit(dateKey, id){
    if (!Auth.isAdmin()) return;
    const s = this.cache[dateKey]?.slots?.[id];
    if (!s) return;
    this.editing = { dateKey, id };
    const row = document.getElementById(`op_edit_${id}`);
    if (!row) return;
    const fld = (k, l, v, ph = '') =>
      `<div class="field"><label>${l}</label><input id="ope_${k}_${id}" value="${escapeHtml(v || '')}" placeholder="${ph}"></div>`;
    row.innerHTML = `<div class="edit-box">
      <div class="section-meta edit-title">MODIFIER LA FICHE</div>
      ${fld('nom','NOM DU DJ', s.nom)}
      <div class="grid-2">
        <div class="field"><label>DÉBUT</label><select id="ope_debut_${id}">${this.HORAIRES.map(h => `<option${h === s.debut ? ' selected' : ''}>${h}</option>`).join('')}</select></div>
        <div class="field"><label>DURÉE</label><select id="ope_duree_${id}">${this.DUREES.map(d => `<option${d === s.duree ? ' selected' : ''}>${d}</option>`).join('')}</select></div>
      </div>
      ${fld('styles','STYLES', s.styles)}
      ${fld('instagram','INSTAGRAM', s.instagram)}
      ${fld('photo','PHOTO (lien)', s.photo, 'https://…')}
      ${fld('email','EMAIL', s.email)}
      ${fld('tel','TÉLÉPHONE', s.tel)}
      ${fld('remarques','REMARQUES', s.remarques)}
      <div id="ope_err_${id}"></div>
      <div class="bc-actions">
        <button class="btn-mini green" onclick="OpenPlatine.saveEdit('${dateKey}','${id}')">Enregistrer</button>
        <button class="btn-mini" onclick="OpenPlatine.cancelEdit('${id}')">Annuler</button>
      </div>
    </div>`;
  },

  cancelEdit(id){
    this.editing = null;
    const row = document.getElementById(`op_edit_${id}`);
    if (row) row.innerHTML = '';
  },

  async saveEdit(dateKey, id){
    if (!Auth.isAdmin()) return;
    const g = k => (document.getElementById(`ope_${k}_${id}`)?.value || '').trim();
    const err = document.getElementById(`ope_err_${id}`);
    const f = { nom:g('nom'), debut:g('debut'), duree:g('duree'), styles:g('styles'),
                instagram:g('instagram'), photo:g('photo'),
                email:g('email'), tel:g('tel'), remarques:g('remarques') };
    if (!f.nom){ err.innerHTML = '<div class="error">Le nom du DJ est obligatoire.</div>'; return; }
    const res = await OpStore.adminUpdate(id, f);
    if (!res.ok){
      err.innerHTML = `<div class="error">${
        res.reason === 'overlap'   ? 'Ce nouvel horaire chevauche un autre set du même soir.'
        : res.reason === 'window'  ? 'Horaire hors de la fenêtre 19h30 – 02h00.'
        : res.reason === 'past'    ? 'Cette soirée est passée : elle n\'est plus modifiable.'
        : res.reason === 'not_admin' ? 'Ton compte n\'a pas les droits d\'administration.'
        : `Échec de l'enregistrement. ${escapeHtml(LAST_STORAGE_ERROR || '')}`
      }</div>`;
      return;
    }
    this.editing = null;
    this.loadAdmin();
  },

  async setStatus(dateKey, id, status){
    if (!Auth.isAdmin()) return;
    const ok = await OpStore.setStatus(id, status);
    if (ok) this.loadAdmin();
  }
};

window.OpenPlatine = OpenPlatine;
