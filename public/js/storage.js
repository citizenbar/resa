// =====================================================================
// STORAGE — couche d'accès aux données (Supabase relationnel)
// =====================================================================
// Cette couche est la SEULE à connaître le schéma relationnel. Elle expose
// aux modules UI des repositories (OpStore / RcStore / EvStore) qui rendent
// les mêmes FORMES que l'UI attend déjà :
//   - OP / EV  : getDate(dateKey) -> { slots: { id: {...} } }
//   - RC       : getDate(dateKey) -> objet réservation | null
// Les opérations sensibles (réserver sans chevauchement, réclamer un code,
// écrire slot+contacts) passent par des RPC SECURITY DEFINER (policies.sql)
// pour être atomiques et sûres.
//
// Conversions clés :
//   - OP : debut "19:30" <-> debut_min via timeToMin/minToTime ; duree "2h" <-> duree_min.
//   - dates : dateKey "YYYY-MM-DD" = colonne date directement.
// =====================================================================

let LAST_STORAGE_ERROR = '';
function storageReady(){ return !!(window.SB_READY && window.sb && window.CONFIG && window.CONFIG.isConfigured); }

const DUREE_TO_MIN = { '1h':60, '2h':120, '3h':180, '4h':240 };
const MIN_TO_DUREE = { 60:'1h', 120:'2h', 180:'3h', 240:'4h' };
// minutes (+24h après minuit) -> "HH:MM" affiché
function minToTime(m){ const h = Math.floor(m/60) % 24; const mm = m % 60; return String(h).padStart(2,'0') + ':' + String(mm).padStart(2,'0'); }

function fail(e){ LAST_STORAGE_ERROR = (e && (e.message || e.code)) || String(e || 'erreur inconnue'); return null; }

// =====================================================================
// OPEN PLATINE
// =====================================================================
const OpStore = {
  // Toutes les lignes (validées pour anon ; tout pour admin) d'une date,
  // remappées en { slots: { id: {nom,styles,debut,duree,status,...} } }.
  async getDate(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return { slots:{} }; }
    const { data, error } = await window.sb
      .from('op_slots')
      .select('id,event_date,debut_min,duree_min,dj_nom,styles,status')
      .eq('event_date', dateKey);
    if (error) { fail(error); return { slots:{} }; }
    const slots = {};
    for (const r of (data || [])) {
      slots[r.id] = {
        id: r.id, nom: r.dj_nom, styles: r.styles || '',
        debut: minToTime(r.debut_min), duree: MIN_TO_DUREE[r.duree_min] || (r.duree_min/60)+'h',
        status: r.status,
      };
    }
    return { slots };
  },

  // Dates ayant au moins une ligne (pour ne lister que les jours utiles).
  async listDateKeys(){
    if (!storageReady()) return [];
    const { data, error } = await window.sb.from('op_slots').select('event_date');
    if (error) { fail(error); return []; }
    return [...new Set((data || []).map(r => r.event_date))];
  },

  // Réservation invité atomique (anti-chevauchement côté serveur via RPC).
  // f = { nom,email,tel,instagram,styles,debut("HH:MM"),duree("2h"),remarques }
  // Retour : { ok:true } | { ok:false, reason:'overlap'|'error' }
  async request(dateKey, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('op_request', {
      p_date: dateKey,
      p_debut_min: timeToMin(f.debut),
      p_duree_min: DUREE_TO_MIN[f.duree] || 60,
      p_dj_nom: f.nom, p_styles: f.styles,
      p_email: f.email, p_tel: f.tel, p_instagram: f.instagram, p_remarques: f.remarques || '',
    });
    if (error) {
      fail(error);
      if ((error.message || '').includes('overlap')) return { ok:false, reason:'overlap' };
      return { ok:false, reason:'error' };
    }
    return { ok:true };
  },

  // Admin : changer le statut d'une réservation.
  async setStatus(id, status){
    if (!storageReady()) return false;
    const { error } = await window.sb.from('op_slots').update({ status }).eq('id', id);
    if (error) { fail(error); return false; }
    return true;
  },

  // Admin : contacts (données perso) d'une réservation.
  async contact(id){
    if (!storageReady()) return null;
    const { data, error } = await window.sb.from('op_contacts').select('*').eq('slot_id', id).maybeSingle();
    if (error) { fail(error); return null; }
    return data;
  },
};

// =====================================================================
// RADIO CAMPUS
// =====================================================================
const RcStore = {
  // Réservation NON refusée d'une date -> objet { emission,animateur,...,status } | null.
  async getDate(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return null; }
    const { data, error } = await window.sb
      .from('rc_reservations')
      .select('id,event_date,emission,animateur,style,micros,materiel,status')
      .eq('event_date', dateKey)
      .neq('status', 'refused')
      .maybeSingle();
    if (error) { fail(error); return null; }
    return data || null;
  },

  async listDateKeys(){
    if (!storageReady()) return [];
    const { data, error } = await window.sb.from('rc_reservations').select('event_date').neq('status','refused');
    if (error) { fail(error); return []; }
    return [...new Set((data || []).map(r => r.event_date))];
  },

  // Réservation invité atomique (1/jour garanti côté serveur).
  // f = { emission,animateur,email,tel,style,micros,materiel,remarques }
  async request(dateKey, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('rc_request', {
      p_date: dateKey, p_emission: f.emission, p_animateur: f.animateur, p_style: f.style,
      p_micros: f.micros, p_materiel: f.materiel || '',
      p_email: f.email, p_tel: f.tel, p_remarques: f.remarques || '',
    });
    if (error) {
      fail(error);
      if ((error.message || '').includes('taken')) return { ok:false, reason:'taken' };
      return { ok:false, reason:'error' };
    }
    return { ok:true };
  },

  async setStatus(id, status){
    if (!storageReady()) return false;
    const { error } = await window.sb.from('rc_reservations').update({ status }).eq('id', id);
    if (error) { fail(error); return false; }
    return true;
  },

  // Admin : toutes les réservations (tous statuts) + contacts, en un appel.
  async listAll(){
    if (!storageReady()) return [];
    const { data, error } = await window.sb
      .from('rc_reservations')
      .select('id,event_date,emission,animateur,style,micros,materiel,status,rc_contacts(email,tel,remarques)')
      .order('event_date', { ascending: true });
    if (error) { fail(error); return []; }
    return (data || []).map(r => {
      const c = (Array.isArray(r.rc_contacts) ? r.rc_contacts[0] : r.rc_contacts) || {};
      return { ...r, email: c.email, tel: c.tel, remarques: c.remarques };
    });
  },
};

// =====================================================================
// EVENTS (système à code via RPC)
// =====================================================================
const EvStore = {
  // Tous les slots d'une date -> { slots: { id: {soiree,code,code_used,nom,debut,fin,styles,status, form?} } }
  // (admin voit code + tout ; anon ne voit que les validés sans code grâce aux RLS)
  async getDate(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return { slots:{} }; }
    const { data, error } = await window.sb
      .from('ev_slots')
      .select('id,event_date,soiree,code,code_used,dj_nom,debut,fin,styles,format,status')
      .eq('event_date', dateKey);
    if (error) { fail(error); return { slots:{} }; }
    const slots = {};
    for (const r of (data || [])) {
      slots[r.id] = {
        id: r.id, soiree: r.soiree, code: r.code, code_used: r.code_used,
        nom: r.dj_nom || 'En attente…',
        debut: r.debut ? r.debut.slice(0,5) : '', fin: r.fin ? r.fin.slice(0,5) : '',
        status: r.status,
        // l'UI teste s.form?.styles pour savoir si la fiche est remplie
        form: r.code_used ? { styles: r.styles || '', format: r.format || '' } : null,
      };
    }
    return { slots };
  },

  async listDateKeys(){
    if (!storageReady()) return [];
    const { data, error } = await window.sb.from('ev_slots').select('event_date');
    if (error) { fail(error); return []; }
    return [...new Set((data || []).map(r => r.event_date))];
  },

  // Admin : créer un slot + code unique (atomique via RPC). -> { code } | null
  async createSlot(dateKey, soiree){
    if (!storageReady()) return null;
    const { data, error } = await window.sb.rpc('ev_create_slot', { p_date: dateKey, p_soiree: soiree });
    if (error) { fail(error); return null; }
    const row = Array.isArray(data) ? data[0] : data;
    return row ? { code: row.code, slotId: row.slot_id } : null;
  },

  // DJ : réclamer un code -> { slotId, soiree, dateKey } | null (invalide/utilisé)
  async claimCode(code){
    if (!storageReady()) return null;
    const { data, error } = await window.sb.rpc('ev_claim_code', { p_code: code });
    if (error) { fail(error); return null; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { slotId: row.slot_id, soiree: row.soiree, dateKey: row.event_date };
  },

  // DJ : remplir la fiche (scelle le code). f = fiche complète. -> { ok, reason }
  async fillSlot(code, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('ev_fill_slot', {
      p_code: code, p_dj_nom: f.nom, p_debut: f.debut, p_fin: f.fin,
      p_styles: f.styles, p_format: f.format || '',
      p_email: f.email, p_tel: f.tel, p_instagram: f.instagram || '',
      p_soundcloud: f.soundcloud || '', p_photo: f.photo || '', p_remarques: f.remarques || '',
    });
    if (error) {
      fail(error);
      if ((error.message || '').includes('code_used')) return { ok:false, reason:'used' };
      return { ok:false, reason:'error' };
    }
    return { ok:true };
  },

  async setStatus(id, status){
    if (!storageReady()) return false;
    const { error } = await window.sb.from('ev_slots').update({ status }).eq('id', id);
    if (error) { fail(error); return false; }
    return true;
  },

  async deleteSlot(id){
    if (!storageReady()) return false;
    const { error } = await window.sb.from('ev_slots').delete().eq('id', id);
    if (error) { fail(error); return false; }
    return true;
  },

  async contact(id){
    if (!storageReady()) return null;
    const { data, error } = await window.sb.from('ev_contacts').select('*').eq('slot_id', id).maybeSingle();
    if (error) { fail(error); return null; }
    return data;
  },
};

// =====================================================================
// PORTAIL — lecture publique de l'agenda (un seul select sur la vue)
// =====================================================================
async function loadPublicAgenda(){
  if (!storageReady()) return [];
  const { data, error } = await window.sb
    .from('public_agenda')
    .select('module,event_date,heure,sort_min,titre,sous_titre')
    .order('event_date', { ascending: true })
    .order('sort_min', { ascending: true });
  if (error) { fail(error); return []; }
  return data || [];
}

window.OpStore = OpStore;
window.RcStore = RcStore;
window.EvStore = EvStore;
window.loadPublicAgenda = loadPublicAgenda;
window.storageReady = storageReady;
