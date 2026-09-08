// =====================================================================
// MODULE EVENTS
// Agenda mensuel public (fermé lundi), 21h30-02h00. Système à code :
// l'admin crée un slot (date + nom soirée) -> code 4 chiffres unique -> envoyé au DJ.
// Le DJ saisit le code (usage unique), choisit ses horaires et remplit sa fiche.
// Données : EvStore
//   cb:ev:YYYY-MM-DD -> { slots: { id: {code,soiree,status,nom,debut,fin,form,createdAt} } }
//   cb:ev:codes      -> { "1234": { dateKey, slotId } }   (index des codes)
// =====================================================================

const Events = {
  HORAIRES: ['21:30','22:00','22:30','23:00','23:30','00:00','00:30','01:00','01:30','02:00'],
  view: 'cal',          // cal | code | form | ok | admin (piloté par router.js)
  lastRef: null,        // uuid de la dernière demande, pour la référence affichée
  mon: new Date().getMonth(),
  yr: new Date().getFullYear(),
  cache: {},            // dateKey -> { slots }
  activeSlot: null,     // { dateKey, slotId, code, soiree, date }
  form: {},
  lastCode: null,
  newSlot: { date:'', soiree:'' },

  emptyForm(){ return { nom:'', email:'', tel:'', debut:'', fin:'', photo:'', styles:'', format:'', instagram:'', soundcloud:'', remarques:'' }; },
  isMonday(d){ return d.getDay() === 1; },
  // recale sur le mois courant si l'affichage a glissé dans le passé (onglet laissé ouvert après minuit/mois)
  seedMonthIfPast(){ const n = new Date(); if (this.yr < n.getFullYear() || (this.yr === n.getFullYear() && this.mon < n.getMonth())){ this.mon = n.getMonth(); this.yr = n.getFullYear(); } },

  async loadDate(d){ const k = dk(d); this.cache[k] = await EvStore.getDate(k); return this.cache[k]; },
  slotsOf(dateKey){ return Object.values(this.cache[dateKey]?.slots || {}); },
  activeSlotsOf(dateKey){ return this.slotsOf(dateKey).filter(s => s.status !== 'refused'); },

  weeksOf(y, m){
    const weeks = []; const last = new Date(y, m+1, 0);
    let cur = new Date(y, m, 1); const dow = cur.getDay();
    cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1));
    while (true){
      const w = []; for (let i = 0; i < 7; i++){ w.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
      weeks.push(w);
      if (cur > last && cur.getDay() === 1) break;
      if (weeks.length > 6) break;
    }
    return weeks;
  },

  render(app){
    if (this.view === 'cal') return this.renderCal(app);
    if (this.view === 'code') return this.renderCode(app);
    if (this.view === 'form') return this.renderForm(app);
    if (this.view === 'ok') return this.renderOk(app);
    if (this.view === 'admin') return this.renderAdmin(app);
  },

  async renderCal(app){
    this.seedMonthIfPast();
    app.innerHTML = `
      <section>
        <div class="eyebrow">Programmation · 21h30 – 02h00</div>
        <h1 class="title">Agenda<br><em>Events</em></h1>
        <p class="lead">Les soirées du Citizen Bar et qui y joue. Tu as reçu un code de l'équipe ? <a style="color:var(--accent);cursor:pointer;text-decoration:underline" onclick="Events.toCode()">Remplis ta fiche.</a></p>
      </section>
      <div class="section-head"><h2 class="section-title">Ce mois-ci</h2>
        <div class="section-meta"><button class="btn-mini" onclick="Events.toCode()">J'ai un code</button></div></div>
      <div id="ev_cal"></div>
      <div class="section-meta" style="margin-top:10px">21h30 – 02h00 · Fermé le lundi</div>
    `;
    await this.renderGrid();
  },

  monthNav(){
    return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <button class="btn-mini" onclick="Events.shiftMonth(-1)">←</button>
      <span style="font-family:'Bowlby One',serif;font-size:15px;letter-spacing:0.04em;min-width:170px;text-align:center">${MONTHS[this.mon].toUpperCase()} ${this.yr}</span>
      <button class="btn-mini" onclick="Events.shiftMonth(1)">→</button>
    </div>`;
  },
  async shiftMonth(dir){
    this.mon += dir;
    if (this.mon < 0){ this.mon = 11; this.yr--; } else if (this.mon > 11){ this.mon = 0; this.yr++; }
    await this.renderGrid();
  },

  async renderGrid(){
    const weeks = this.weeksOf(this.yr, this.mon);
    const flat = weeks.flat().filter(d => d.getMonth() === this.mon);
    // Liste les clés existantes (évite un get sur chaque jour sans event)
    const existing = new Set(await EvStore.listDateKeys());
    await Promise.all(flat.map(d => {
      const k = dk(d);
      if (existing.has(k)) return this.loadDate(d);
      this.cache[k] = { slots:{} };           // jour connu vide, pas d'appel réseau
      return Promise.resolve();
    }));
    const c = document.getElementById('ev_cal');
    if (!c) return;
    const head = DAYS_SHORT.slice(1).concat(DAYS_SHORT[0]);
    c.innerHTML = this.monthNav() + `
      <div style="border:1px solid var(--muted)">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);background:var(--bg-3)">
          ${head.map(d => `<div style="padding:9px 0;text-align:center;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:0.15em;color:var(--fg-dim)">${d}</div>`).join('')}
        </div>
        ${weeks.map(w => `<div style="display:grid;grid-template-columns:repeat(7,1fr)">${w.map(d => this.cellHtml(d)).join('')}</div>`).join('')}
      </div>`;
  },

  cellHtml(date){
    const inM = date.getMonth() === this.mon;
    const past = isPast(date);
    const monday = this.isMonday(date);
    const dateKey = dk(date);
    const slots = this.activeSlotsOf(dateKey);
    const hasEvent = slots.length > 0;
    const isToday = dk(date) === dk(new Date());
    const numColor = !inM ? 'var(--muted)' : (past || monday) ? 'var(--muted)' : 'var(--fg)';
    const named = slots.filter(s => s.form?.styles);
    const pending = slots.filter(s => !s.form?.styles).length;
    return `<div style="min-height:74px;padding:7px 5px;border-top:1px solid var(--muted);border-left:1px solid var(--muted);display:flex;flex-direction:column;align-items:center;gap:3px;${hasEvent && inM && !past ? 'background:color-mix(in srgb,var(--accent) 8%,transparent)' : isToday && inM ? 'background:var(--bg-3)' : ''}">
      <span style="font-family:'Fraunces',serif;font-size:14px;color:${numColor};font-weight:${isToday ? '600' : '400'}">${date.getDate()}</span>
      ${inM && !past && !monday && hasEvent ? `<div style="width:100%;text-align:left">
        ${named.map(s => `<div class="cal-label is-strong" style="color:var(--accent)">${escapeHtml(s.soiree)}</div><div class="cal-label" style="color:var(--fg-dim)">${s.nom !== 'En attente…' ? escapeHtml(s.nom) + ' · ' : ''}${escapeHtml(s.form.styles)}</div>`).join('')}
        ${pending > 0 ? `<div class="cal-label" style="color:var(--muted)">${pending} slot${pending > 1 ? 's' : ''} à venir</div>` : ''}
      </div>` : ''}
    </div>`;
  },

  // ---- DJ code flow ----
  toCode(){ this.view = 'code'; this.render(document.getElementById('app')); },
  renderCode(app){
    app.innerHTML = `<div class="admin-login">
      <div class="eyebrow" style="justify-content:center">Accès DJ</div>
      <h2 class="section-title" style="font-size:24px;margin-bottom:6px">Entre ton code</h2>
      <p class="lead" style="font-size:14px;text-align:center;margin:0 auto 20px">Tu as reçu un code à 6 chiffres de l'équipe du Citizen Bar.</p>
      <div class="field"><input id="ev_code" maxlength="6" inputmode="numeric" placeholder="000000" style="text-align:center;font-size:28px;letter-spacing:0.4em;font-family:'JetBrains Mono',monospace;font-weight:700" onkeydown="if(event.key==='Enter')Events.checkCode()"></div>
      <div id="ev_code_err"></div>
      <button class="btn" onclick="Events.checkCode()">Accéder</button>
      <button class="btn-mini" style="margin-top:10px;border:none;color:var(--fg-dim)" onclick="Events.back()">← Retour</button>
    </div>`;
    setTimeout(() => document.getElementById('ev_code')?.focus(), 40);
  },

  async checkCode(){
    const code = (document.getElementById('ev_code')?.value || '').trim();
    const err = document.getElementById('ev_code_err');
    if (!/^\d{6}$/.test(code)){ err.innerHTML = '<div class="error">Le code fait 6 chiffres.</div>'; return; }
    const ref = await EvStore.claimCode(code);   // RPC : valide + usage unique (ne lit pas ev_slots en anon)
    if (!ref){
      err.innerHTML = storageReady()
        ? '<div class="error">Code invalide ou déjà utilisé. Vérifie le code reçu.</div>'
        : '<div class="error">Backend non configuré (Supabase).</div>';
      return;
    }
    this.activeSlot = { dateKey: ref.dateKey, slotId: ref.slotId, code, soiree: ref.soiree, date: parseDk(ref.dateKey) };
    this.form = this.emptyForm();
    this.view = 'form'; this.render(document.getElementById('app'));
  },

  renderForm(app){
    const a = this.activeSlot, f = this.form;
    const fields1 = [['nom','NOM DU DJ / GROUPE *','Ton nom de scène'],['email','EMAIL *','contact@email.com'],['tel','TÉLÉPHONE *','06 xx xx xx xx']];
    // photo gérée à part (upload fichier OU lien, obligatoire) ; le reste en champs texte.
    const fields2 = [['styles','STYLE MUSICAL *','House, Techno, Jungle…'],['format','FORMAT — CDJ/USB, VINYL, CONTRÔLEUR','Précise ton setup'],['instagram','INSTAGRAM','@tonpseudo'],['soundcloud','SOUNDCLOUD / LIEN PROMO','soundcloud.com/…'],['remarques','REMARQUES / CHANGEOVER','Infos techniques…']];
    app.innerHTML = `
      <div style="margin-bottom:20px;padding:14px 16px;background:var(--bg-2);border-left:3px solid var(--accent)">
        <div class="section-meta">TON CRÉNEAU</div>
        <div class="bc-name" style="margin-top:4px">${escapeHtml(a.soiree)}</div>
        <div class="section-meta" style="color:var(--accent);margin-top:4px">${a.date.getDate()} ${MONTHS[a.date.getMonth()]} ${a.date.getFullYear()} · CITIZEN BAR</div>
      </div>
      ${fields1.map(([k,l,p]) => `<div class="field"><label>${l}</label><input id="ev_${k}" value="${escapeHtml(f[k])}" placeholder="${p}"></div>`).join('')}
      <div class="grid-2">
        <div class="field"><label>Heure de début *</label><select id="ev_debut">${['<option value="">Choisir…</option>'].concat(this.HORAIRES.map(h => `<option>${h}</option>`)).join('')}</select></div>
        <div class="field"><label>Heure de fin *</label><select id="ev_fin">${['<option value="">Choisir…</option>'].concat(this.HORAIRES.map(h => `<option>${h}</option>`)).join('')}</select></div>
      </div>
      <div class="field">
        <label>PHOTO / VISUEL DE L'ARTISTE *</label>
        <div class="section-meta" style="margin-bottom:6px">Téléverse une image (JPG, PNG ou WebP, 5 Mo max) OU colle un lien.</div>
        <input type="file" id="ev_photo_file" accept="image/jpeg,image/png,image/webp" onchange="Events.onPhotoPick()">
        <div id="ev_photo_status" class="section-meta" style="margin-top:4px"></div>
        <div style="margin-top:8px"><input id="ev_photo" value="${escapeHtml(f.photo)}" placeholder="…ou lien : Drive, Instagram, WeTransfer…"></div>
      </div>
      ${fields2.map(([k,l,p]) => `<div class="field"><label>${l}</label><input id="ev_${k}" value="${escapeHtml(f[k])}" placeholder="${p}"></div>`).join('')}
      <div id="ev_err"></div>
      <button class="btn" onclick="Events.submitForm()">Envoyer ma fiche</button>`;
  },

  readForm(){
    const g = id => (document.getElementById(id)?.value || '').trim();
    return { nom:g('ev_nom'), email:g('ev_email'), tel:g('ev_tel'), debut:g('ev_debut'), fin:g('ev_fin'),
      photo:g('ev_photo'), styles:g('ev_styles'), format:g('ev_format'), instagram:g('ev_instagram'),
      soundcloud:g('ev_soundcloud'), remarques:g('ev_remarques') };
  },

  // Le DJ choisit un fichier : validation immédiate (type + taille) + feedback.
  // Si un fichier valide est choisi, on vide le champ lien (les deux sont en OR).
  onPhotoPick(){
    const input = document.getElementById('ev_photo_file');
    const status = document.getElementById('ev_photo_status');
    const link = document.getElementById('ev_photo');
    const file = input?.files?.[0];
    if (!file){ if (status) status.textContent = ''; return; }
    const okType = ['image/jpeg','image/png','image/webp'].includes(file.type);
    if (!okType){ status.innerHTML = '<span style="color:var(--refused)">Format non supporté (JPG, PNG, WebP).</span>'; input.value = ''; return; }
    if (file.size > 5*1024*1024){ status.innerHTML = '<span style="color:var(--refused)">Fichier trop lourd (5 Mo max).</span>'; input.value = ''; return; }
    status.innerHTML = `<span style="color:var(--ok)">✓ ${escapeHtml(file.name)} prêt à être envoyé.</span>`;
    if (link) link.value = '';   // un fichier prime sur le lien
  },

  async submitForm(){
    if (this._submitting) return;
    const f = this.readForm(); this.form = f;
    const err = document.getElementById('ev_err');
    const btn = document.querySelector('#app .btn');
    const fileInput = document.getElementById('ev_photo_file');
    const photoFile = fileInput?.files?.[0] || null;
    if (!f.nom || !f.email || !f.tel || !f.styles || !f.debut || !f.fin){
      err.innerHTML = '<div class="error">Merci de remplir tous les champs obligatoires (*).</div>'; return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)){
      err.innerHTML = '<div class="error">Email invalide.</div>'; return;
    }
    if (timeToMin(f.fin) <= timeToMin(f.debut)){
      err.innerHTML = '<div class="error">L\'heure de fin doit être après l\'heure de début.</div>'; return;
    }
    // Photo OBLIGATOIRE : un fichier OU un lien (au moins un des deux).
    if (!photoFile && !f.photo){
      err.innerHTML = '<div class="error">La photo de l\'artiste est obligatoire : téléverse une image ou colle un lien.</div>'; return;
    }
    const a = this.activeSlot;
    this._submitting = true; if (btn){ btn.disabled = true; btn.textContent = 'Envoi…'; }

    // Si un fichier est fourni, on l'uploade d'abord (il prime sur le lien).
    if (photoFile){
      if (btn) btn.textContent = 'Envoi de la photo…';
      const up = await EvStore.uploadPhoto(a.code, photoFile);
      if (!up.ok){
        this._submitting = false;
        if (btn){ btn.disabled = false; btn.textContent = 'Envoyer ma fiche'; }
        err.innerHTML =
          up.reason === 'too_big' ? '<div class="error">Photo trop lourde (5 Mo max).</div>'
          : up.reason === 'bad_type' ? '<div class="error">Format de photo non supporté (JPG, PNG, WebP).</div>'
          : up.reason === 'code' ? '<div class="error">Code Events invalide ou déjà utilisé.</div>'
          : '<div class="error">Échec de l\'envoi de la photo. Réessaie, ou colle un lien à la place.</div>';
        return;
      }
      f.photo = up.url;   // l'URL Storage remplace tout lien éventuel
    }

    if (btn) btn.textContent = 'Envoi…';
    const res = await EvStore.fillSlot(a.code, f);   // RPC : scelle le code (usage unique atomique)
    this._submitting = false;
    if (!res.ok){
      if (btn){ btn.disabled = false; btn.textContent = 'Envoyer ma fiche'; }
      err.innerHTML =
        res.reason === 'used' ? '<div class="error">Ce code a déjà été utilisé.</div>'
        : res.reason === 'config' ? '<div class="error">Backend non configuré (Supabase).</div>'
        : `<div class="error">Échec de l'enregistrement.<br>Détail : ${escapeHtml(LAST_STORAGE_ERROR || 'inconnu')}</div>`;
      return;
    }
    this.lastRef = res.id;   // reference a afficher sur l'ecran de confirmation
    this.view = 'ok'; this.render(document.getElementById('app'));
  },

  renderOk(app){
    app.innerHTML = `<div class="success">
      <div class="eyebrow" style="justify-content:center">Fiche envoyée</div>
      <h2>En attente de validation</h2>
      <p>Ta fiche a bien été reçue. L'équipe du Citizen Bar te contacte pour confirmer.</p>
      ${refBlockHtml('ev', this.lastRef)}
      <button class="btn" style="max-width:280px;margin:0 auto" onclick="Events.back()">Retour à l'agenda</button>
    </div>`;
  },

  back(){ this.view = 'cal'; this.activeSlot = null; this.render(document.getElementById('app')); },

  // ---- admin ----
  async renderAdmin(app){
    app.innerHTML = `
      <div class="eyebrow">Administration</div>
      <h2 class="title" style="font-size:clamp(36px,7vw,64px)">Dashboard <em>Events</em></h2>
      <div class="section-head"><h2 class="section-title">Créneaux & codes</h2>
        <div class="section-meta">
          <button class="btn-mini" onclick="Events.loadAdmin()">↻ Rafraîchir</button>
        </div></div>
      <div style="background:var(--bg-2);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);padding:18px;margin-bottom:24px">
        <div class="section-meta" style="color:var(--accent);font-weight:700;margin-bottom:12px">CRÉER UN CRÉNEAU</div>
        <div class="grid-2">
          <div class="field" style="margin-bottom:0"><label>Date</label><input type="date" id="ev_new_date" value="${this.newSlot.date}"></div>
          <div class="field" style="margin-bottom:0"><label>Nom de la soirée</label><input id="ev_new_soiree" value="${escapeHtml(this.newSlot.soiree)}" placeholder="Ex : Soirée Techno"></div>
        </div>
        <div id="ev_new_err"></div>
        <button class="btn-ghost btn" style="margin-top:12px" onclick="Events.createSlot()">Générer le code DJ</button>
      </div>
      <div id="ev_lastcode"></div>
      <div id="ev_admin"><div class="portal-empty">Chargement…</div></div>`;
    if (this.lastCode) this.renderLastCode();
    this.loadAdmin();
  },

  renderLastCode(){
    const el = document.getElementById('ev_lastcode'); if (!el || !this.lastCode) return;
    el.innerHTML = `<div style="background:color-mix(in srgb,var(--ok) 12%,transparent);border:1px solid color-mix(in srgb,var(--ok) 40%,transparent);padding:18px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
      <div><div class="section-meta" style="color:var(--ok);font-weight:700">DERNIER CODE GÉNÉRÉ</div><div class="bc-name" style="margin-top:4px">${escapeHtml(this.lastCode.soiree)} · ${escapeHtml(this.lastCode.dateLabel)}</div></div>
      <div style="text-align:right"><div style="font-family:'Bowlby One',serif;font-size:40px;color:var(--ok);letter-spacing:0.1em">${this.lastCode.code}</div><div class="section-meta">À envoyer au DJ</div></div>
    </div>`;
  },

  async createSlot(){
    if (!Auth.isAdmin()) return;
    const date = (document.getElementById('ev_new_date')?.value || '').trim();
    const soiree = (document.getElementById('ev_new_soiree')?.value || '').trim();
    this.newSlot = { date, soiree };
    const err = document.getElementById('ev_new_err');
    if (!date || !soiree){ err.innerHTML = '<div class="error">Renseigne la date et le nom de la soirée.</div>'; return; }
    const d = parseDk(date);
    if (this.isMonday(d)){ err.innerHTML = '<div class="error">Le bar est fermé le lundi.</div>'; return; }
    if (isPast(d)){ err.innerHTML = '<div class="error">Cette date est déjà passée.</div>'; return; }
    // RPC : génère un code 6 chiffres unique + crée le slot, atomiquement.
    const res = await EvStore.createSlot(dk(d), soiree);
    if (!res){ err.innerHTML = `<div class="error">Échec. ${escapeHtml(LAST_STORAGE_ERROR || 'Réessaie.')}</div>`; return; }
    this.lastCode = { code: res.code, soiree, dateLabel: fmtLong(d) };
    this.newSlot = { date:'', soiree:'' };
    err.innerHTML = '';
    this.renderAdmin(document.getElementById('app'));
  },

  async loadAdmin(){
    const dateKeys = (await EvStore.listDateKeys()).sort();
    // getDateAdmin (et non getDate) : lit en plus code + code_used pour afficher
    // le code à l'admin. Ces colonnes sont fermées à anon (fix-column-leak.sql).
    const datas = await Promise.all(dateKeys.map(k => EvStore.getDateAdmin(k)));
    const groups = [];
    dateKeys.forEach((dateKey, i) => {
      const data = datas[i]; if (!data) return;
      this.cache[dateKey] = data;
      const slots = Object.entries(data.slots || {}); if (!slots.length) return;
      groups.push({ dateKey, date: parseDk(dateKey), slots });
    });
    // enrichit les fiches remplies de leurs contacts (table privée), en parallèle
    const flat = groups.flatMap(g => g.slots.filter(([,s]) => s.form).map(([id, s]) => ({ id, s })));
    const contacts = await Promise.all(flat.map(x => EvStore.contact(x.id)));
    // Les contacts ne portent PLUS que email / tel / remarques : les liens promo
    // (instagram, soundcloud, photo) ont migré vers ev_slots avec
    // migrate-public-events.sql et sont déjà chargés par getDateAdmin. Les lire
    // ici depuis ev_contacts renvoyait undefined, et l'admin ne voyait jamais
    // le lien photo d'une fiche pourtant remplie.
    flat.forEach((x, i) => { const c = contacts[i] || {}; x.s.form = { ...x.s.form, email:c.email, tel:c.tel, remarques:c.remarques }; });
    const all = groups.flatMap(g => g.slots.map(([,s]) => s));
    const count = st => all.filter(s => s.status === st).length;
    const target = document.getElementById('ev_admin'); if (!target) return;
    const today = todayMidnight();
    const upcoming = groups.filter(g => g.date >= today).sort((a,b) => a.date - b.date);
    const past = groups.filter(g => g.date < today).sort((a,b) => b.date - a.date);
    const stats = `<div class="admin-stats">
      <div class="stat" style="--st-c:var(--pending)"><div class="v">${count('pending')}</div><div class="l">En attente</div></div>
      <div class="stat" style="--st-c:var(--ok)"><div class="v">${count('validated')}</div><div class="l">Validés</div></div>
      <div class="stat" style="--st-c:var(--refused)"><div class="v">${count('refused')}</div><div class="l">Refusés</div></div>
    </div>`;
    if (!all.length){ target.innerHTML = stats + `<div class="portal-empty">Aucun créneau créé.</div>`; return; }
    target.innerHTML = stats + this.groupsHtml(upcoming, false) + this.groupsHtml(past, true);
  },

  groupsHtml(groups, isPastGroup){
    if (!groups.length) return '';
    return `<div class="admin-group"><div class="admin-group-title">${isPastGroup ? 'Passé' : 'À venir'}</div>` +
      groups.map(g => {
        const slots = g.slots.sort(([,a],[,b]) => (a.debut || '').localeCompare(b.debut || ''));
        return `<div style="margin-bottom:16px${isPastGroup ? ';opacity:0.6' : ''}">
          <div class="section-meta" style="color:var(--accent);font-weight:700;margin-bottom:8px">${g.date.getDate()} ${MONTHS[g.date.getMonth()]} ${g.date.getFullYear()}</div>
          ${slots.map(([id,s]) => this.slotCard(g.dateKey, id, s, isPastGroup)).join('')}
        </div>`;
      }).join('') + `</div>`;
  },

  slotCard(dateKey, id, s, isPastCard){
    const bc = s.status === 'validated' ? 'var(--ok)' : s.status === 'refused' ? 'var(--refused)' : 'var(--pending)';
    const filled = !!s.form;
    const meta = filled ? [['réf',refFromId('ev', s.id)],['email',s.form.email],['tél',s.form.tel], s.form.format && ['format',s.form.format], s.form.instagram && ['instagram',s.form.instagram], s.form.soundcloud && ['soundcloud',s.form.soundcloud], s.form.photo && ['photo',s.form.photo], s.form.remarques && ['remarques',s.form.remarques]].filter(Boolean) : [];
    return `<div class="booking-card" style="--bc:${bc}">
      <div class="bc-head">
        <div>
          <div class="bc-name">${escapeHtml(s.soiree)}</div>
          <div class="bc-sub">${escapeHtml(s.nom)}${filled && s.form.styles ? ' · ' + escapeHtml(s.form.styles) : ''}</div>
          ${s.debut && s.fin ? `<div class="section-meta" style="color:var(--accent);margin-top:4px">${escapeHtml(s.debut)} – ${escapeHtml(s.fin)}</div>` : ''}
        </div>
        <div style="text-align:right">
          <div class="section-meta">CODE : <b style="color:var(--fg)">${escapeHtml(s.code)}</b></div>
          <span class="pill ${s.status}" style="margin-top:6px;display:inline-block">${s.status === 'validated' ? 'Validé' : s.status === 'refused' ? 'Refusé' : filled ? 'En attente' : 'Fiche non remplie'}</span>
        </div>
      </div>
      ${filled ? `<div class="bc-meta">${meta.map(([k,v]) => `<div><span class="k">${k}</span>${escapeHtml(v)}</div>`).join('')}</div>` : ''}
      ${isPastCard ? '' : `<div class="bc-actions">
        ${filled && s.status !== 'validated' ? `<button class="btn-mini green" onclick="Events.setStatus('${id}','validated')">Valider</button>` : ''}
        ${s.status !== 'refused' ? `<button class="btn-mini red" onclick="Events.setStatus('${id}','refused')">Refuser</button>` : ''}
        ${s.status === 'refused' ? `<button class="btn-mini" onclick="Events.setStatus('${id}','pending')">Remettre en attente</button>` : ''}
        <button class="btn-mini" onclick="Events.openEdit('${dateKey}','${id}')">${filled ? 'Modifier' : 'Remplir'}</button>
        <button class="btn-mini" onclick="Events.deleteSlot('${id}')">Supprimer</button>
      </div>`}
      <div id="ev_edit_${id}"></div>
    </div>`;
  },

  // ÉDITION D'UNE FICHE (admin). Absent sur les soirées passées : le CHECK
  // ev_not_past est revalidé à chaque écriture. La DATE, le CODE et code_used
  // ne sont volontairement pas modifiables (le code est à usage unique).
  //
  // Effet de bord utile : une fiche que le DJ n'a jamais remplie peut être
  // saisie ici par l'admin. Le bouton Valider apparaît ensuite normalement,
  // puisqu'il ne dépend que de la présence de `styles`.
  openEdit(dateKey, id){
    if (!Auth.isAdmin()) return;
    const s = this.cache[dateKey]?.slots?.[id];
    if (!s) return;
    const row = document.getElementById(`ev_edit_${id}`);
    if (!row) return;
    const f = s.form || {};
    const fld = (k, l, v, ph = '') =>
      `<div class="field"><label>${l}</label><input id="eve_${k}_${id}" value="${escapeHtml(v || '')}" placeholder="${ph}"></div>`;
    const opts = (sel) => ['<option value="">—</option>'].concat(
      this.HORAIRES.map(h => `<option${h === sel ? ' selected' : ''}>${h}</option>`)).join('');
    row.innerHTML = `<div class="edit-box">
      <div class="section-meta edit-title">${s.form ? 'MODIFIER LA FICHE' : 'REMPLIR LA FICHE À LA PLACE DU DJ'}</div>
      ${fld('soiree','NOM DE LA SOIRÉE', s.soiree)}
      ${fld('nom','NOM DU DJ', s.nom === 'En attente…' ? '' : s.nom)}
      <div class="grid-2">
        <div class="field"><label>DÉBUT</label><select id="eve_debut_${id}">${opts(s.debut)}</select></div>
        <div class="field"><label>FIN</label><select id="eve_fin_${id}">${opts(s.fin)}</select></div>
      </div>
      ${fld('styles','STYLES', f.styles)}
      ${fld('format','FORMAT', f.format)}
      ${fld('instagram','INSTAGRAM', f.instagram)}
      ${fld('soundcloud','SOUNDCLOUD', f.soundcloud)}
      ${fld('photo','PHOTO (lien)', f.photo, 'https://…')}
      ${fld('email','EMAIL', f.email)}
      ${fld('tel','TÉLÉPHONE', f.tel)}
      ${fld('remarques','REMARQUES', f.remarques)}
      <div id="eve_err_${id}"></div>
      <div class="bc-actions">
        <button class="btn-mini green" onclick="Events.saveEdit('${dateKey}','${id}')">Enregistrer</button>
        <button class="btn-mini" onclick="Events.cancelEdit('${id}')">Annuler</button>
      </div>
    </div>`;
  },

  cancelEdit(id){
    const row = document.getElementById(`ev_edit_${id}`);
    if (row) row.innerHTML = '';
  },

  async saveEdit(dateKey, id){
    if (!Auth.isAdmin()) return;
    const g = k => (document.getElementById(`eve_${k}_${id}`)?.value || '').trim();
    const err = document.getElementById(`eve_err_${id}`);
    const f = { soiree:g('soiree'), nom:g('nom'), debut:g('debut'), fin:g('fin'),
                styles:g('styles'), format:g('format'), instagram:g('instagram'),
                soundcloud:g('soundcloud'), photo:g('photo'),
                email:g('email'), tel:g('tel'), remarques:g('remarques') };
    if (!f.soiree){ err.innerHTML = '<div class="error">Le nom de la soirée est obligatoire.</div>'; return; }
    if (f.debut && f.fin && timeToMin(f.fin) <= timeToMin(f.debut)){
      err.innerHTML = '<div class="error">L\'heure de fin doit être après l\'heure de début.</div>'; return;
    }
    const res = await EvStore.adminUpdate(id, f);
    if (!res.ok){
      err.innerHTML = `<div class="error">${
        res.reason === 'past'        ? 'Cette soirée est passée : elle n\'est plus modifiable.'
        : res.reason === 'not_admin' ? 'Ton compte n\'a pas les droits d\'administration.'
        : `Échec de l'enregistrement. ${escapeHtml(LAST_STORAGE_ERROR || '')}`
      }</div>`;
      return;
    }
    this.loadAdmin();
  },

  async setStatus(id, status){
    if (!Auth.isAdmin()) return;
    const ok = await EvStore.setStatus(id, status);
    if (ok) this.loadAdmin();
  },

  async deleteSlot(id){
    if (!Auth.isAdmin()) return;
    if (!confirm('Supprimer ce créneau et son code ?')) return;
    const ok = await EvStore.deleteSlot(id);   // ON DELETE CASCADE supprime aussi le contact
    if (ok) this.loadAdmin();
  }
};

window.Events = Events;
