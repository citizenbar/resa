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
