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
// =====================================================================
// UPLOAD D'UNE PHOTO — commun aux trois modules
// =====================================================================
// La Vercel Function /api/upload-photo autorise puis signe ; le navigateur
// uploade DIRECTEMENT vers Storage avec le token signé, sans jamais voir de
// secret. Deux régimes d'autorisation côté serveur :
//   - avec un code Events  : le code vaut autorisation (5 uploads par code) ;
//   - sans code (RC / OP)  : quota par IP (10 par heure).
// Passer code = null depuis Radio Campus et Open Platine.
//
// -> { ok:true, url } | { ok:false, reason:'too_big'|'bad_type'|'code'|'quota'|'net'|'config' }
async function uploadArtistPhoto(code, file){
  if (!storageReady()) return { ok:false, reason:'config' };
  // Validation client : type + taille. Le type déclaré (file.type) est
  // falsifiable, donc on confirme par les MAGIC BYTES (vrai contenu) ci-dessous.
  // La vraie barrière serveur reste les contraintes du bucket
  // (allowed_mime_types + file_size_limit) ; ceci est la défense client.
  const ALLOWED = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };
  const ext = ALLOWED[file.type];
  if (!ext) return { ok:false, reason:'bad_type' };
  if (file.size > 5 * 1024 * 1024) return { ok:false, reason:'too_big' };
  const realExt = await sniffImage(file);
  if (!realExt || realExt !== ext) return { ok:false, reason:'bad_type' };
  const contentType = file.type;  // cohérent avec ext validé + magic bytes
  try {
    // 1) demander une signature (la fonction autorise : code ou quota IP)
    const payload = code ? { code, ext } : { ext };
    const r = await fetch('/api/upload-photo', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      if (r.status === 403) return { ok:false, reason:'code' };
      if (r.status === 429) return { ok:false, reason:'quota' };
      return { ok:false, reason:'net' };
    }
    const { bucket, path, token, publicUrl } = await r.json();
    if (!bucket || !path || !token) return { ok:false, reason:'net' };
    // 2) uploader le fichier DIRECTEMENT vers Storage via le token signé.
    //    contentType imposé depuis l'ext validée (pas un type arbitraire).
    const { error } = await window.sb.storage.from(bucket)
      .uploadToSignedUrl(path, token, file, { contentType });
    if (error) { fail(error); return { ok:false, reason:'net' }; }
    return { ok:true, url: publicUrl };
  } catch (e) {
    fail(e); return { ok:false, reason:'net' };
  }
}

// Lit les premiers octets du fichier et renvoie 'jpg'|'png'|'webp' si la
// signature binaire correspond à une vraie image, sinon null. Empêche qu'un
// fichier HTML/SVG renommé .png passe la validation par extension.
async function sniffImage(file){
  try {
    const buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    // PNG : 89 50 4E 47
    if (buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47) return 'png';
    // JPEG : FF D8 FF
    if (buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF) return 'jpg';
    // WebP : "RIFF" .... "WEBP"
    if (buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 &&
        buf[8]===0x57 && buf[9]===0x45 && buf[10]===0x42 && buf[11]===0x50) return 'webp';
    return null;
  } catch (_) { return null; }
}

// Traduit l'erreur d'une RPC *_admin_update en motif exploitable par l'UI.
// Les fonctions lèvent des exceptions nommées ('past', 'overlap', 'window',
// 'not_admin', 'not_found') ; PostgREST les remonte dans error.message.
function rpcReason(error){
  const m = (error && error.message) || '';
  for (const r of ['not_admin','not_found','overlap','window_or_past','window','past']) {
    if (m.includes(r)) return r === 'window_or_past' ? 'window' : r;
  }
  return 'error';
}

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

  // ADMIN : même chose, plus les colonnes promo (instagram, photo).
  //
  // Chemin SÉPARÉ du getDate public, volontairement. op_slots.photo n'existe
  // qu'après op-photo-2026-09.sql : si le front partait avant le SQL, un select
  // sur une colonne inexistante casserait le calendrier public d'Open Platine.
  // En isolant la lecture ici, le chemin public reste intact quel que soit
  // l'ordre de déploiement.
  async getDateAdmin(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return { slots:{} }; }
    const { data, error } = await window.sb
      .from('op_slots')
      .select('id,event_date,debut_min,duree_min,dj_nom,styles,status,instagram,photo')
      .eq('event_date', dateKey);
    if (error) { fail(error); return { slots:{} }; }
    const slots = {};
    for (const r of (data || [])) {
      slots[r.id] = {
        id: r.id, nom: r.dj_nom, styles: r.styles || '',
        debut: minToTime(r.debut_min), duree: MIN_TO_DUREE[r.duree_min] || (r.duree_min/60)+'h',
        status: r.status, instagram: r.instagram || '', photo: r.photo || '',
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

  // OCCUPATION PUBLIQUE : plages déjà prises (pending incluses), pour que
  // la timeline et l'anti-chevauchement soient justes AVANT la saisie.
  // Sans ça, les créneaux en attente sont invisibles (RLS) et l'utilisateur
  // remplit un formulaire pour se faire refuser à l'envoi.
  // -> dateKey -> [ { debut, duree, status } ] (aucune donnée personnelle)
  async occupancy(){
    if (!storageReady()) return {};
    const { data, error } = await window.sb
      .from('op_occupancy').select('event_date,debut_min,duree_min,occupancy');
    if (error) { fail(error); return {}; }
    const map = {};
    for (const r of (data || [])) {
      (map[r.event_date] = map[r.event_date] || []).push({
        debut: minToTime(r.debut_min),
        duree: MIN_TO_DUREE[r.duree_min] || (r.duree_min / 60) + 'h',
        status: r.occupancy,
      });
    }
    return map;
  },

  // Réservation invité atomique (anti-chevauchement côté serveur via RPC).
  // f = { nom,email,tel,instagram,styles,debut("HH:MM"),duree("2h"),remarques,photo }
  // Retour : { ok:true } | { ok:false, reason:'overlap'|'error' }
  async request(dateKey, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    // La RPC renvoie l'uuid cree : on le remonte pour en deriver la
    // reference courte affichee au demandeur (cf. refFromId dans helpers).
    const { data, error } = await window.sb.rpc('op_request', {
      p_date: dateKey,
      p_debut_min: timeToMin(f.debut),
      p_duree_min: DUREE_TO_MIN[f.duree] || 60,
      p_dj_nom: f.nom, p_styles: f.styles,
      p_email: f.email, p_tel: f.tel, p_instagram: f.instagram, p_remarques: f.remarques || '',
      p_photo: f.photo || '',
    });
    if (error) {
      fail(error);
      if ((error.message || '').includes('overlap')) return { ok:false, reason:'overlap' };
      return { ok:false, reason:'error' };
    }
    return { ok:true, id: Array.isArray(data) ? data[0] : data };
  },

  // ADMIN : corriger une fiche (vitrine + contacts, même transaction).
  // Passe par une RPC security definer : les tables *_contacts n'ont aucune
  // policy UPDATE, et le CHECK op_not_past est revalidé à chaque écriture.
  // -> { ok:true } | { ok:false, reason:'overlap'|'window'|'past'|'not_admin'|'error' }
  async adminUpdate(id, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('op_admin_update', {
      p_id: id,
      p_dj_nom: f.nom, p_styles: f.styles,
      p_debut_min: timeToMin(f.debut), p_duree_min: DUREE_TO_MIN[f.duree] || 60,
      p_instagram: f.instagram || '', p_photo: f.photo || '',
      p_email: f.email || '', p_tel: f.tel || '', p_remarques: f.remarques || '',
    });
    if (error) { fail(error); return { ok:false, reason: rpcReason(error) }; }
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
    // Calendrier PUBLIC (anon) : on ne lit QUE les colonnes vitrine. micros et
    // materiel sont des notes logistiques internes, fermées à anon au niveau
    // colonne (supabase/fix-column-leak.sql). L'admin les lit via listAll().
    const { data, error } = await window.sb
      .from('rc_reservations')
      .select('id,event_date,emission,animateur,style,status')
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

  // OCCUPATION PUBLIQUE : dateKey -> 'pending' | 'validated'.
  // Indispensable côté calendrier : les policies RLS ne laissent voir à un
  // visiteur que les lignes 'validated', donc une demande en attente est
  // invisible et la date paraît libre. La vue rc_occupancy expose l'état
  // d'occupation SANS aucune donnée personnelle (cf. public-occupancy.sql).
  async occupancy(){
    if (!storageReady()) return {};
    const { data, error } = await window.sb.from('rc_occupancy').select('event_date,occupancy');
    if (error) { fail(error); return {}; }
    const map = {};
    for (const r of (data || [])) map[r.event_date] = r.occupancy;
    return map;
  },

  // Réservation invité atomique (1/jour garanti côté serveur).
  // f = { emission,animateur,email,tel,style,micros,materiel,remarques,photo }
  async request(dateKey, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { data, error } = await window.sb.rpc('rc_request', {
      p_date: dateKey, p_emission: f.emission, p_animateur: f.animateur, p_style: f.style,
      p_micros: f.micros, p_materiel: f.materiel || '',
      p_email: f.email, p_tel: f.tel, p_remarques: f.remarques || '',
      p_photo: f.photo || '',
    });
    if (error) {
      fail(error);
      if ((error.message || '').includes('taken')) return { ok:false, reason:'taken' };
      return { ok:false, reason:'error' };
    }
    return { ok:true, id: Array.isArray(data) ? data[0] : data };
  },

  // ADMIN : corriger une fiche (vitrine + contacts, même transaction).
  // -> { ok:true } | { ok:false, reason:'past'|'not_admin'|'error' }
  async adminUpdate(id, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('rc_admin_update', {
      p_id: id,
      p_emission: f.emission, p_animateur: f.animateur, p_style: f.style || '',
      p_micros: f.micros || '', p_materiel: f.materiel || '', p_photo: f.photo || '',
      p_email: f.email || '', p_tel: f.tel || '', p_remarques: f.remarques || '',
    });
    if (error) { fail(error); return { ok:false, reason: rpcReason(error) }; }
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
      .select('id,event_date,emission,animateur,style,micros,materiel,status,photo,rc_contacts(email,tel,remarques)')
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
  // Tous les slots d'une date -> { slots: { id: {soiree,nom,debut,fin,styles,status, form?} } }
  // CALENDRIER PUBLIC (anon) : on ne lit NI code NI code_used (fermés à anon au
  // niveau colonne, cf. supabase/fix-column-leak.sql). Le code n'est utile qu'à
  // l'admin, qui passe par getDateAdmin(). On dérive "fiche remplie" du styles
  // non vide (le DJ renseigne son style quand il remplit) plutôt que de code_used.
  async getDate(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return { slots:{} }; }
    const { data, error } = await window.sb
      .from('ev_slots')
      .select('id,event_date,soiree,dj_nom,debut,fin,styles,format,status')
      .eq('event_date', dateKey);
    if (error) { fail(error); return { slots:{} }; }
    return EvStore._mapSlots(data);
  },

  // ADMIN (authenticated) : comme getDate mais lit en plus code + code_used,
  // colonnes réservées à l'admin. Utilisé par loadAdmin pour afficher le code.
  async getDateAdmin(dateKey){
    if (!storageReady()) { LAST_STORAGE_ERROR = 'backend non configuré'; return { slots:{} }; }
    const { data, error } = await window.sb
      .from('ev_slots')
      .select('id,event_date,soiree,code,code_used,dj_nom,debut,fin,styles,format,status,instagram,soundcloud,photo')
      .eq('event_date', dateKey);
    if (error) { fail(error); return { slots:{} }; }
    return EvStore._mapSlots(data);
  },

  // Remappe les lignes ev_slots en { slots: { id: {...} } }. code/code_used sont
  // repris s'ils sont présents (chemin admin), sinon omis (chemin public anon).
  _mapSlots(data){
    const slots = {};
    for (const r of (data || [])) {
      slots[r.id] = {
        id: r.id, soiree: r.soiree,
        code: r.code, code_used: r.code_used,   // undefined côté public, c'est voulu
        nom: r.dj_nom || 'En attente…',
        debut: r.debut ? r.debut.slice(0,5) : '', fin: r.fin ? r.fin.slice(0,5) : '',
        status: r.status,
        // l'UI teste s.form?.styles pour savoir si la fiche est remplie.
        // Une fiche remplie a un styles renseigné par le DJ.
        // Les liens promo vivent sur ev_slots depuis migrate-public-events.sql :
        // ils ne sont présents que sur le chemin admin (getDateAdmin les
        // sélectionne), et valent undefined côté public — ce qui est voulu.
        form: r.styles ? {
          styles: r.styles || '', format: r.format || '',
          instagram: r.instagram || '', soundcloud: r.soundcloud || '', photo: r.photo || '',
        } : null,
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

  // DJ : uploader une photo. Le code Events vaut autorisation et porte son
  // propre compteur (5 uploads par code) : on le transmet tel quel.
  // Voir uploadArtistPhoto() plus haut, commun aux trois modules.
  async uploadPhoto(code, file){ return uploadArtistPhoto(code, file); },


  // DJ : remplir la fiche (scelle le code). f = fiche complète. -> { ok, reason }
  async fillSlot(code, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { data, error } = await window.sb.rpc('ev_fill_slot', {
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
    return { ok:true, id: Array.isArray(data) ? data[0] : data };
  },

  // ADMIN : corriger une fiche (vitrine + contacts, même transaction).
  // La date, le code et code_used ne sont volontairement PAS modifiables.
  // -> { ok:true } | { ok:false, reason:'past'|'not_admin'|'error' }
  async adminUpdate(id, f){
    if (!storageReady()) return { ok:false, reason:'config' };
    const { error } = await window.sb.rpc('ev_admin_update', {
      p_id: id,
      p_soiree: f.soiree, p_dj_nom: f.nom,
      p_debut: f.debut || null, p_fin: f.fin || null,
      p_styles: f.styles || '', p_format: f.format || '',
      p_instagram: f.instagram || '', p_soundcloud: f.soundcloud || '', p_photo: f.photo || '',
      p_email: f.email || '', p_tel: f.tel || '', p_remarques: f.remarques || '',
    });
    if (error) { fail(error); return { ok:false, reason: rpcReason(error) }; }
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
