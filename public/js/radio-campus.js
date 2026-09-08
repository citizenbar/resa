// =====================================================================
// MODULE RADIO CAMPUS
// Calendrier mensuel mardi–dimanche (fermé lundi + mercredi), un créneau/jour
// 19h00-21h30, réservation min 2 semaines à l'avance, statuts attente/validé/refusé.
// Données : RcStore (clé cb:rc:YYYY-MM-DD -> { ...resa, status }).
// =====================================================================

const RadioCampus = {
  view: 'cal',          // cal | form | ok | admin (piloté par router.js)
  lastRef: null,        // uuid de la dernière demande, pour la référence affichée
  occ: {},              // dateKey -> 'pending' | 'validated' (vue rc_occupancy)
  mon: new Date().getMonth(),
  yr: new Date().getFullYear(),
  selDate: null,
  cache: {},            // dateKey -> resa | null
  form: {},

  emptyForm(){ return { emission:'', animateur:'', email:'', tel:'', style:'', micros:'', materiel:'', remarques:'', photo:'' }; },

  // lundi=1, mercredi=3 fermés
  isClosed(d){ const g = d.getDay(); return g === 1 || g === 3; },
  // recale sur le mois courant si l'affichage a glissé dans le passé (onglet laissé ouvert)
  seedMonthIfPast(){ const n = new Date(); if (this.yr < n.getFullYear() || (this.yr === n.getFullYear() && this.mon < n.getMonth())){ this.mon = n.getMonth(); this.yr = n.getFullYear(); } },
  minDate(){ const m = todayMidnight(); m.setDate(m.getDate() + 14); return m; },

  async loadDate(d){ const k = dk(d); this.cache[k] = await RcStore.getDate(k); return this.cache[k]; },

  // Occupation d'une date : 'validated' (prise), 'pending' (demande en
  // cours, encore réservable) ou null (libre).
  // Vient de la vue rc_occupancy, PAS du cache : les policies RLS cachent
  // les lignes 'pending' au visiteur, donc this.cache est nul sur une date
  // demandée mais non validée. Sans cette source, le calendrier affiche
  // « libre » une date déjà demandée (bug UX constaté en prod).
  occupancyOf(d){ return this.occ[dk(d)] || null; },
  isBlocked(d){ return this.occupancyOf(d) === 'validated'; },
  isPendingOn(d){ return this.occupancyOf(d) === 'pending'; },

  isAvailable(d){
    if (this.isClosed(d)) return false;
    if (isPast(d) || d < this.minDate()) return false;
    // Une date 'pending' RESTE réservable : le visiteur est averti dans le
    // formulaire que sa demande pourra être refusée. Seule une date
    // 'validated' est fermée.
    return !this.isBlocked(d);
  },

  // grille de semaines lundi–dimanche couvrant le mois
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
    if (this.view === 'form') return this.renderForm(app);
    if (this.view === 'ok') return this.renderOk(app);
    if (this.view === 'admin') return this.renderAdmin(app);
  },

  async renderCal(app){
    this.seedMonthIfPast();
    app.innerHTML = `
      <section>
        <div class="eyebrow">Antenne libre · 19h00 – 21h30</div>
        <h1 class="title">Radio<br><em>Campus</em></h1>
        <p class="lead">Anime ton émission en direct du bar. Du mardi au dimanche, fermé lundi et mercredi. Réservation deux semaines à l'avance minimum.</p>
      </section>
      <div class="section-head"><h2 class="section-title">Calendrier</h2>
        <div class="section-meta"></div></div>
      <div class="legend">
        <div class="item"><span class="sw" style="background:var(--accent)"></span>Disponible</div>
        <div class="item"><span class="sw" style="background:var(--pending)"></span>Demande en cours</div>
        <div class="item"><span class="sw" style="background:var(--refused)"></span>Réservé</div>
        <div class="item"><span class="sw" style="background:var(--bg-3);border:1px solid var(--muted)"></span>Fermé / passé</div>
      </div>
      <div id="rc_cal"></div>
      <div class="section-meta" style="margin-top:10px">Réservation minimum 2 semaines à l'avance.</div>
    `;
    await this.renderGrid();
  },

  monthNav(){
    return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <button class="btn-mini" onclick="RadioCampus.shiftMonth(-1)">←</button>
      <span style="font-family:'Bowlby One',serif;font-size:15px;letter-spacing:0.04em;min-width:170px;text-align:center">${MONTHS[this.mon].toUpperCase()} ${this.yr}</span>
      <button class="btn-mini" onclick="RadioCampus.shiftMonth(1)">→</button>
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
    // Liste les clés existantes (évite un get sur chaque jour libre)
    // Occupation publique d'abord : c'est elle qui fait foi pour libre/pris
    // (le cache ne contient que ce que la RLS laisse voir, donc pas les
    // demandes en attente).
    this.occ = await RcStore.occupancy();
    const existing = new Set(await RcStore.listDateKeys());
    await Promise.all(flat.map(d => {
      const k = dk(d);
      if (existing.has(k)) return this.loadDate(d);
      this.cache[k] = null;                   // jour connu vide, pas d'appel réseau
      return Promise.resolve();
    }));
    const c = document.getElementById('rc_cal');
    if (!c) return;
    const head = DAYS_SHORT.slice(1).concat(DAYS_SHORT[0]); // LUN..DIM
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
    const closed = this.isClosed(date);
    const soon = !past && date < this.minDate();
    const blocked = this.isBlocked(date);
    const av = this.isAvailable(date);
    const isToday = dk(date) === dk(new Date());
    let dotColor = null;
    const pending = this.isPendingOn(date);
    if (inM && !past && !closed){
      if (blocked) dotColor = 'var(--refused)';
      else if (pending) dotColor = 'var(--pending)';   // demande en cours, encore réservable
      else if (soon) dotColor = 'var(--muted)';
      else dotColor = 'var(--accent)';
    }
    const numColor = !inM ? 'var(--muted)' : (past || closed || soon) ? 'var(--muted)' : 'var(--fg)';
    const r = this.cache[dk(date)];
    const onclick = av ? `onclick="RadioCampus.openForm('${dk(date)}')"` : '';
    return `<div ${onclick} style="min-height:64px;padding:8px 4px;text-align:center;border-top:1px solid var(--muted);border-left:1px solid var(--muted);display:flex;flex-direction:column;align-items:center;gap:4px;${av ? 'cursor:pointer' : ''};${isToday && inM ? 'background:var(--bg-3)' : ''}">
      <span style="font-family:'Fraunces',serif;font-size:14px;color:${numColor};font-weight:${isToday ? '600' : '400'}">${date.getDate()}</span>
      ${dotColor ? `<div style="width:5px;height:5px;border-radius:50%;background:${dotColor}"></div>` : ''}
      ${inM && blocked && r ? `<div class="cal-label" style="color:var(--refused)">${escapeHtml(r.emission || '')}</div>` : ''}
      ${inM && !blocked && pending ? `<div class="cal-label" style="color:var(--pending)">demandé</div>` : ''}
    </div>`;
  },

  async openForm(dateKey){
    this.selDate = parseDk(dateKey);
    await this.loadDate(this.selDate);
    // Occupation à jour : une date peut avoir été validée depuis l'affichage.
    this.occ = await RcStore.occupancy();
    if (this.isBlocked(this.selDate)){ await this.renderGrid(); return; } // pris entre temps
    // On NE réinitialise le formulaire que s'il est vierge. Si l'utilisateur
    // a déjà saisi quelque chose (cas d'un créneau pris au moment de l'envoi,
    // où on l'invite à choisir une autre date), sa saisie est conservée.
    if (!this.hasInput()) this.form = this.emptyForm();
    this.view = 'form';
    this.render(document.getElementById('app'));
  },

  // Vrai si au moins un champ du formulaire a été rempli.
  hasInput(){
    const f = this.form || {};
    return Object.keys(this.emptyForm()).some(k => String(f[k] || '').trim() !== '');
  },

  renderForm(app){
    const d = this.selDate, f = this.form;
    const fields = [
      ['emission',"NOM DE L'ÉMISSION *","Ex : La Nuit Électronique"],
      ['animateur','ANIMATEUR / RESPONSABLE *','Nom et prénom'],
      ['email','EMAIL *','contact@email.com'],
      ['tel','TÉLÉPHONE *','06 xx xx xx xx'],
      ['style','STYLE / THÉMATIQUE *','Musique, talk, culture…'],
      ['micros','NOMBRE DE MICROS *','Ex : 3'],
      ['materiel','MATÉRIEL','Platines, instruments…'],
      ['remarques','REMARQUES','Infos complémentaires…'],
    ];
    app.innerHTML = `
      <button class="btn-back" onclick="RadioCampus.back()">← Retour au calendrier</button>
      <div class="eyebrow">Nouvelle réservation</div>
      <h2 class="section-title" style="font-size:26px;margin-bottom:4px">${fmtDay(d)} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</h2>
      <div class="section-meta" style="color:var(--accent);margin-bottom:20px">19H00 – 21H30</div>
      ${this.isPendingOn(d) ? `<div class="warn-banner">
        <strong>Une autre demande est déjà en attente sur cette date.</strong>
        Tu peux quand même déposer la tienne : l'équipe tranchera. Sache simplement
        qu'elle pourra être refusée si l'autre demande est validée en premier.
      </div>` : ''}
      ${fields.map(([k,l,p]) => `<div class="field"><label>${l}</label><input id="rc_${k}" value="${escapeHtml(f[k])}" placeholder="${p}"></div>`).join('')}
      <div class="field">
        <label>PHOTO / VISUEL DE L'ÉMISSION</label>
        <div class="section-meta" style="margin-bottom:6px">Facultatif, mais c'est ce qui nous permet de faire l'affiche. Téléverse une image (JPG, PNG ou WebP, 5 Mo max) OU colle un lien.</div>
        <input type="file" id="rc_photo_file" accept="image/jpeg,image/png,image/webp" onchange="RadioCampus.onPhotoPick()">
        <div id="rc_photo_status" class="section-meta" style="margin-top:4px"></div>
        <div style="margin-top:8px"><input id="rc_photo" value="${escapeHtml(f.photo || '')}" placeholder="…ou lien : Drive, Instagram, WeTransfer…"></div>
      </div>
      <div id="rc_err"></div>
      <button class="btn" onclick="RadioCampus.submit()">Confirmer la réservation</button>
      <div style="margin-top:18px;padding:14px 16px;background:var(--bg-2);border-left:2px solid var(--accent)">
        <div class="section-meta" style="margin-bottom:8px">RÈGLES</div>
        ${['Réservation minimum 2 semaines à l\'avance','Annulation au moins 48h avant, nous contacter directement','Être présent 15 min avant le direct'].map(r => `<div style="font-family:'Fraunces',serif;font-size:14px;color:var(--fg-dim);margin-bottom:3px">• ${r}</div>`).join('')}
      </div>`;
  },

  readForm(){
    const g = id => (document.getElementById(id)?.value || '').trim();
    return { emission:g('rc_emission'), animateur:g('rc_animateur'), email:g('rc_email'), tel:g('rc_tel'),
      style:g('rc_style'), micros:g('rc_micros'), materiel:g('rc_materiel'), remarques:g('rc_remarques'),
      photo:g('rc_photo') };
  },

  // Choix d'un fichier : validation immédiate (type + taille) + retour visuel.
  // Un fichier valide vide le champ lien (les deux sont exclusifs, cf. Events).
  onPhotoPick(){
    const input = document.getElementById('rc_photo_file');
    const status = document.getElementById('rc_photo_status');
    const link = document.getElementById('rc_photo');
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
    if (this._submitting) return;
    const f = this.readForm(); this.form = f;
    const err = document.getElementById('rc_err');
    const btn = document.querySelector('#app .btn');
    if (!f.emission || !f.animateur || !f.email || !f.tel || !f.style || !f.micros){
      err.innerHTML = '<div class="error">Merci de remplir tous les champs obligatoires (*).</div>'; return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)){
      err.innerHTML = '<div class="error">Email invalide.</div>'; return;
    }
    const dateKey = dk(this.selDate);
    const photoFile = document.getElementById('rc_photo_file')?.files?.[0] || null;
    this._submitting = true; if (btn){ btn.disabled = true; btn.textContent = 'Envoi…'; }

    // Photo facultative. Si un fichier est fourni, on l'uploade d'abord : il
    // prime sur le lien. Pas de code ici (module ouvert), donc l'autorisation
    // serveur passe par le quota d'IP (upload-quota-2026-09.sql).
    if (photoFile){
      if (btn) btn.textContent = 'Envoi de la photo…';
      const up = await uploadArtistPhoto(null, photoFile);
      if (!up.ok){
        this._submitting = false;
        if (btn){ btn.disabled = false; btn.textContent = 'Confirmer la réservation'; }
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

    const res = await RcStore.request(dateKey, f);
    this._submitting = false;
    if (!res.ok){
      if (btn){ btn.disabled = false; btn.textContent = 'Confirmer la réservation'; }
      if (res.reason === 'taken'){
        // On NE renvoie PAS au calendrier : la saisie serait perdue. On
        // rafraîchit l'occupation (la date passe en « réservé ») et on
        // laisse l'utilisateur choisir une autre date en gardant son texte.
        this.occ = await RcStore.occupancy();
        err.innerHTML = `<div class="error">
          Ce créneau vient d'être validé pour quelqu'un d'autre. Ta saisie est conservée :
          reviens au calendrier et choisis une autre date, le formulaire sera pré-rempli.
        </div>`;
        return;
      }
      err.innerHTML = res.reason === 'config' ? '<div class="error">Backend non configuré (Supabase). Vérifie supabaseUrl et supabaseAnonKey dans config.js.</div>'
        : `<div class="error">Échec de l'enregistrement.<br>Détail : ${escapeHtml(LAST_STORAGE_ERROR || 'inconnu')}</div>`;
      return;
    }
    this.lastRef = res.id;   // reference a afficher sur l'ecran de confirmation
    this.form = this.emptyForm();   // succès : on repart d'un formulaire vierge
    this.view = 'ok'; this.render(document.getElementById('app'));
  },

  renderOk(app){
    app.innerHTML = `<div class="success">
      <div class="eyebrow" style="justify-content:center">Demande envoyée</div>
      <h2>Réservation en attente</h2>
      <p>Ta demande a bien été reçue. L'équipe du Citizen Bar revient vers toi pour confirmer le créneau.</p>
      ${refBlockHtml('rc', this.lastRef)}
      <button class="btn" style="max-width:280px;margin:0 auto" onclick="RadioCampus.back()">Retour au calendrier</button>
    </div>`;
  },

  back(){ this.view = 'cal'; this.render(document.getElementById('app')); },

  // --- admin ---
  async renderAdmin(app){
    app.innerHTML = `
      <div class="eyebrow">Administration</div>
      <h2 class="title" style="font-size:clamp(36px,7vw,64px)">Dashboard <em>Radio</em></h2>
      <div class="section-head"><h2 class="section-title">Réservations</h2>
        <div class="section-meta">
          <button class="btn-mini" onclick="RadioCampus.loadAdmin()">↻ Rafraîchir</button>
        </div></div>
      <div id="rc_admin"><div class="portal-empty">Chargement…</div></div>`;
    this.loadAdmin();
  },

  async loadAdmin(){
    // admin : toutes les réservations (y compris refusées), contacts inclus
    const rows = await RcStore.listAll();
    // Index par id : le formulaire d'édition y relit la ligne sans refaire d'appel.
    this.adminRows = {};
    for (const r of rows) this.adminRows[r.id] = r;
    const all = rows.map(r => ({ dateKey: r.event_date, date: parseDk(r.event_date), r }));
    const count = st => all.filter(x => x.r.status === st).length;
    const target = document.getElementById('rc_admin'); if (!target) return;
    const today = todayMidnight();
    const upcoming = all.filter(x => x.date >= today).sort((a,b) => a.date - b.date);
    const past = all.filter(x => x.date < today).sort((a,b) => b.date - a.date);
    const stats = `<div class="admin-stats">
      <div class="stat" style="--st-c:var(--pending)"><div class="v">${count('pending')}</div><div class="l">En attente</div></div>
      <div class="stat" style="--st-c:var(--ok)"><div class="v">${count('validated')}</div><div class="l">Validées</div></div>
      <div class="stat" style="--st-c:var(--refused)"><div class="v">${count('refused')}</div><div class="l">Refusées</div></div>
    </div>`;
    if (!all.length){ target.innerHTML = stats + `<div class="portal-empty">Aucune réservation.</div>`; return; }
    target.innerHTML = stats + this.listHtml(upcoming, false) + this.listHtml(past, true);
  },

  listHtml(arr, isPastList){
    if (!arr.length) return '';
    return `<div class="admin-group"><div class="admin-group-title">${isPastList ? 'Passé' : 'À venir'}</div>` +
      arr.map(({ dateKey, date, r }) => {
        const bc = r.status === 'validated' ? 'var(--ok)' : r.status === 'refused' ? 'var(--refused)' : 'var(--pending)';
        const meta = [['réf',refFromId('rc', r.id)],['style',r.style],['micros',r.micros],['email',r.email],['tél',r.tel], r.materiel && ['matériel',r.materiel], r.photo && ['photo',r.photo], r.remarques && ['remarques',r.remarques]].filter(Boolean);
        return `<div class="booking-card" style="--bc:${bc}${isPastList ? ';opacity:0.6' : ''}">
          <div class="bc-head">
            <div><div class="bc-name">${escapeHtml(r.emission)}</div><div class="bc-sub">${escapeHtml(r.animateur)} · ${fmtDay(date)} ${date.getDate()} ${MONTHS[date.getMonth()]}</div></div>
            <span class="pill ${r.status}">${r.status === 'validated' ? 'Validée' : r.status === 'refused' ? 'Refusée' : 'En attente'}</span>
          </div>
          <div class="bc-meta">${meta.map(([k,v]) => `<div><span class="k">${k}</span>${escapeHtml(v)}</div>`).join('')}</div>
          ${isPastList ? '' : `<div class="bc-actions">
            ${r.status !== 'validated' ? `<button class="btn-mini green" onclick="RadioCampus.setStatus('${r.id}','validated')">Valider</button>` : ''}
            ${r.status !== 'refused' ? `<button class="btn-mini red" onclick="RadioCampus.setStatus('${r.id}','refused')">Refuser</button>` : ''}
            ${r.status === 'refused' ? `<button class="btn-mini" onclick="RadioCampus.setStatus('${r.id}','pending')">Remettre en attente</button>` : ''}
            <button class="btn-mini" onclick="RadioCampus.openEdit('${r.id}')">Modifier</button>
          </div>`}
          <div id="rc_edit_${r.id}"></div>
        </div>`;
      }).join('') + `</div>`;
  },

  // ÉDITION D'UNE FICHE (admin). Bouton absent sur les émissions passées : le
  // CHECK rc_not_past est revalidé à chaque écriture. La DATE n'est pas
  // éditable (rc_one_per_day) : pour déplacer, supprimer et recréer.
  openEdit(id){
    if (!Auth.isAdmin()) return;
    const r = (this.adminRows || {})[id];
    if (!r) return;
    const row = document.getElementById(`rc_edit_${id}`);
    if (!row) return;
    const fld = (k, l, v, ph = '') =>
      `<div class="field"><label>${l}</label><input id="rce_${k}_${id}" value="${escapeHtml(v || '')}" placeholder="${ph}"></div>`;
    row.innerHTML = `<div class="edit-box">
      <div class="section-meta edit-title">MODIFIER LA FICHE</div>
      ${fld('emission',"NOM DE L'ÉMISSION", r.emission)}
      ${fld('animateur','ANIMATEUR', r.animateur)}
      ${fld('style','STYLE / THÉMATIQUE', r.style)}
      ${fld('micros','NOMBRE DE MICROS', r.micros)}
      ${fld('materiel','MATÉRIEL', r.materiel)}
      ${fld('photo','PHOTO (lien)', r.photo, 'https://…')}
      ${fld('email','EMAIL', r.email)}
      ${fld('tel','TÉLÉPHONE', r.tel)}
      ${fld('remarques','REMARQUES', r.remarques)}
      <div id="rce_err_${id}"></div>
      <div class="bc-actions">
        <button class="btn-mini green" onclick="RadioCampus.saveEdit('${id}')">Enregistrer</button>
        <button class="btn-mini" onclick="RadioCampus.cancelEdit('${id}')">Annuler</button>
      </div>
    </div>`;
  },

  cancelEdit(id){
    const row = document.getElementById(`rc_edit_${id}`);
    if (row) row.innerHTML = '';
  },

  async saveEdit(id){
    if (!Auth.isAdmin()) return;
    const g = k => (document.getElementById(`rce_${k}_${id}`)?.value || '').trim();
    const err = document.getElementById(`rce_err_${id}`);
    const f = { emission:g('emission'), animateur:g('animateur'), style:g('style'),
                micros:g('micros'), materiel:g('materiel'), photo:g('photo'),
                email:g('email'), tel:g('tel'), remarques:g('remarques') };
    if (!f.emission || !f.animateur){
      err.innerHTML = '<div class="error">Le nom de l\'émission et l\'animateur sont obligatoires.</div>'; return;
    }
    const res = await RcStore.adminUpdate(id, f);
    if (!res.ok){
      err.innerHTML = `<div class="error">${
        res.reason === 'past'        ? 'Cette émission est passée : elle n\'est plus modifiable.'
        : res.reason === 'not_admin' ? 'Ton compte n\'a pas les droits d\'administration.'
        : `Échec de l'enregistrement. ${escapeHtml(LAST_STORAGE_ERROR || '')}`
      }</div>`;
      return;
    }
    this.loadAdmin();
  },

  async setStatus(id, status){
    if (!Auth.isAdmin()) return;
    const ok = await RcStore.setStatus(id, status);
    if (ok) this.loadAdmin();
  }
};

window.RadioCampus = RadioCampus;
