// =====================================================================
// PORTAIL PUBLIC — agenda
// Agrège les réservations VALIDÉES des trois modules en une liste
// chronologique (lecture seule). C'est la vue par défaut.
// =====================================================================

const Portal = {
  async render(app){
    app.innerHTML = `
      <section>
        <div class="eyebrow">Toute la prog en un endroit</div>
        <h1 class="title">Ce qui se<br><em>passe ici</em></h1>
        <p class="lead">Open Platine le mercredi, les émissions de Radio Campus, les soirées Events. Réserve ton créneau ou viens voir qui joue.</p>
      </section>

      <div class="module-cards">
        <div class="module-card" style="--card-accent:var(--op)" onclick="go('op')">
          <div class="mc-tag">Mercredi · Open decks</div>
          <div class="mc-title">Open Platine</div>
          <div class="mc-desc">Tu es DJ ? Réserve ton set d'1h à 4h sur la scène ouverte du mercredi.</div>
        </div>
        <div class="module-card" style="--card-accent:var(--rc)" onclick="go('rc')">
          <div class="mc-tag">Mar–Dim · Antenne libre</div>
          <div class="mc-title">Radio Campus</div>
          <div class="mc-desc">Anime ton émission en direct du bar, 19h-21h30. Réservation 2 semaines à l'avance.</div>
        </div>
        <div class="module-card" style="--card-accent:var(--ev)" onclick="go('ev')">
          <div class="mc-tag">Soirées · Sur invitation</div>
          <div class="mc-title">Events</div>
          <div class="mc-desc">Tu as reçu un code ? Remplis ta fiche pour ta soirée programmée.</div>
        </div>
      </div>

      <div class="section-head">
        <h2 class="section-title">À l'affiche</h2>
        <div class="section-meta" id="portalMeta">chargement…</div>
      </div>
      <div id="portalList"><div class="portal-empty">Chargement de la programmation…</div></div>
    `;
    this.load();
  },

  async load(){
    const today = todayMidnight();
    const TAGS = { op:'OPEN PLATINE', rc:'RADIO CAMPUS', ev:'EVENTS' };

    // Un seul select sur la vue public_agenda (validés, sans données perso).
    // La vue agrège déjà les 3 modules et est filtrée status='validated'.
    const rows = await loadPublicAgenda();
    const items = rows
      .map(r => ({ date: parseDk(r.event_date), sortT: r.sort_min, mod: r.module,
        tag: TAGS[r.module] || r.module.toUpperCase(),
        title: r.titre, sub: r.sous_titre || '', time: r.heure }))
      .filter(it => it.date >= today);

    items.sort((a,b) => a.date - b.date || a.sortT - b.sortT);

    const meta = document.getElementById('portalMeta');
    const list = document.getElementById('portalList');
    if (!meta || !list) return;
    if (!items.length){
      meta.textContent = '0 date';
      list.innerHTML = `<div class="portal-empty">Rien de programmé pour l'instant. Reviens bientôt.</div>`;
      return;
    }
    meta.textContent = `${items.length} créneau${items.length > 1 ? 'x' : ''}`;
    list.innerHTML = `<div class="portal-grid">` + items.map(it => `
      <div class="portal-row">
        <div class="portal-date">${it.date.getDate()} ${MONTHS_SHORT[it.date.getMonth()]}<span>${DAYS_SHORT[it.date.getDay()]}</span></div>
        <div class="portal-tag ${it.mod}">${it.tag}</div>
        <div>
          <div class="portal-title">${escapeHtml(it.title)}</div>
          ${it.sub ? `<div class="portal-sub">${escapeHtml(it.sub)}</div>` : ''}
        </div>
        <div class="portal-time">${escapeHtml(it.time)}</div>
      </div>`).join('') + `</div>`;
  }
};

window.Portal = Portal;
