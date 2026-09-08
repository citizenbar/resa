// =====================================================================
// HELPERS — constantes + utilitaires date / texte
// Exposés globalement (window) ; chargé avant les modules.
// =====================================================================

const MONTHS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const MONTHS_SHORT = ['JAN','FÉV','MAR','AVR','MAI','JUI','JUL','AOÛ','SEP','OCT','NOV','DÉC'];
const DAYS = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const DAYS_SHORT = ['DIM','LUN','MAR','MER','JEU','VEN','SAM'];

const MODULE_ACCENT = { portal: 'var(--op)', op: 'var(--op)', rc: 'var(--rc)', ev: 'var(--ev)' };
const MODULE_HEX = { op: '#d92e15', rc: '#b07d12', ev: '#2f5fd0' };

function pad(n){ return String(n).padStart(2,'0'); }

// clé ISO YYYY-MM-DD (date locale, sans décalage UTC)
function dk(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function parseDk(key){ const [y,m,dd] = key.split('-').map(Number); return new Date(y, m-1, dd); }

function fmtLong(d){ return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
function fmtDay(d){ return DAYS[d.getDay()]; }

function todayMidnight(){ const n = new Date(); n.setHours(0,0,0,0); return n; }
function isPast(d){ const a = new Date(d); a.setHours(0,0,0,0); return a < todayMidnight(); }

// minutes depuis minuit ; les heures après minuit (< 6h) comptent +24h
// pour que les soirées qui passent minuit s'ordonnent correctement.
function timeToMin(t){ const [h,m] = t.split(':').map(Number); return (h < 6 ? h + 24 : h) * 60 + m; }

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// id court unique (création de slot / réservation)
function genId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

// =====================================================================
// RÉFÉRENCE DE RÉSERVATION (à citer par le demandeur)
// =====================================================================
// Dérive une référence courte et lisible de l'uuid renvoyé par la RPC :
//   "1f7a80a9-3a79-..." + module 'rc'  ->  "RC-1F7A"
//
// Ce n'est PAS un secret et ça n'ouvre aucun accès : c'est un identifiant
// à citer ("bonjour, ma réservation RC-1F7A"). L'admin la retrouve en
// comparant le début de l'uuid dans son dashboard. On garde 4 caractères :
// assez pour lever l'ambiguïté sur le volume d'un bar, assez court pour
// être dicté au téléphone.
const MODULE_REF_PREFIX = { op: 'OP', rc: 'RC', ev: 'EV' };

function refFromId(module, id){
  if (!id) return '';
  const clean = String(id).replace(/-/g, '').toUpperCase();
  return (MODULE_REF_PREFIX[module] || 'CB') + '-' + clean.slice(0, 4);
}

// Bloc HTML affiché sur l'écran de confirmation. Vide si l'id manque
// (backend indisponible) : mieux vaut pas de référence qu'une fausse.
function refBlockHtml(module, id){
  const ref = refFromId(module, id);
  if (!ref) return '';
  return `
    <div class="resa-ref">
      <div class="resa-ref-label">Ta référence</div>
      <div class="resa-ref-row">
        <code class="resa-ref-code" id="resaRef">${escapeHtml(ref)}</code>
        <button class="btn-mini" onclick="copyRef()">Copier</button>
      </div>
      <div class="resa-ref-hint">Garde-la : elle nous permet de retrouver ta demande si tu nous contactes.</div>
    </div>`;
}

// Copie la référence dans le presse-papier, avec repli si l'API n'est pas
// disponible (http non sécurisé, navigateur ancien) : on sélectionne le
// texte pour que l'utilisateur puisse copier à la main.
function copyRef(){
  const el = document.getElementById('resaRef');
  if (!el) return;
  const txt = el.textContent.trim();
  const done = (btn) => { if (btn) { const o = btn.textContent; btn.textContent = 'Copié'; setTimeout(() => btn.textContent = o, 1600); } };
  const btn = el.parentElement && el.parentElement.querySelector('button');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => done(btn)).catch(() => selectText(el));
  } else {
    selectText(el);
  }
}

function selectText(el){
  try {
    const r = document.createRange(); r.selectNodeContents(el);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (_) {}
}
