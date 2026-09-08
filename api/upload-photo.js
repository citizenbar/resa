// =====================================================================
// VERCEL FUNCTION — signe un upload de photo d'artiste (module Events)
// =====================================================================
// Rôle : permettre au DJ (anonyme, il a juste un CODE Events) d'uploader sa
// photo dans Supabase Storage SANS exposer de secret au navigateur.
//
// Flux (signed upload URL, approche recommandée par Supabase) :
//   1. Le navigateur POST { code, ext } ici.
//   2. La fonction VÉRIFIE le code Events (valide + pas encore utilisé) via la
//      RPC publique ev_claim_code (ne consomme pas le code, le scellage se fait
//      plus tard par ev_fill_slot). Pas de code valide -> 403, aucune signature.
//   3. La fonction génère un nom de fichier UUID (non devinable, non
//      énumérable) et demande à Supabase Storage une signed upload URL, avec la
//      clé SECRÈTE (sb_secret_, uniquement en variable d'env Vercel, JAMAIS
//      côté client ni dans le repo).
//   4. Elle renvoie { path, token, publicUrl } au navigateur, qui uploade le
//      fichier DIRECTEMENT vers Storage via uploadToSignedUrl (sans clé).
//
// Sécurité : anon n'a aucune policy d'écriture sur le bucket (cf.
// supabase/storage-artist-photos.sql). Le seul moyen d'uploader est de passer
// par cette fonction, qui exige un code Events valide. La clé secrète ne quitte
// jamais le serveur. Le fichier ne transite pas par la fonction (pas de limite
// de body), seul un petit JSON circule.
// =====================================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://wutzagmeeyzmqgzqaxwy.supabase.co';

// Clé PUBLISHABLE (anon) : sert UNIQUEMENT à appeler la RPC ev_claim_code pour
// vérifier le code. Publique par nature, déjà dans le repo (config.js).
const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_xcRt1nCgbYzQroWnmHITKg_teiyMDlh';

// Clé SECRÈTE (sb_secret_ / service_role) : signe l'upload. JAMAIS de fallback
// en dur. Si absente, la fonction refuse de signer (500 neutre). À configurer
// dans Vercel : Settings -> Environment Variables -> SUPABASE_SECRET_KEY.
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const BUCKET = 'artist-photos';

// Extensions d'image autorisées (cohérent avec la validation côté client).
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

// UUID v4 sans dépendance (crypto natif Node 18+ sur Vercel).
function uuid() {
  return require('crypto').randomUUID();
}

// Vérifie le code Events ET réserve un "crédit" d'upload, en une opération
// atomique côté Postgres (RPC ev_can_upload). Renvoie true si le code existe,
// n'est pas scellé, et n'a pas dépassé la limite d'uploads (le compteur est
// incrémenté dans la même transaction). Ferme l'abus "uploads illimités par
// code" (finding C1) : contrairement à ev_claim_code, cette RPC consomme un
// crédit à chaque appel réussi.
async function reserveUploadSlot(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ev_can_upload`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_code: code }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    // ev_can_upload renvoie un booléen scalaire.
    const data = await res.json();
    return data === true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Demande une signed upload URL à Supabase Storage (clé secrète).
async function signUpload(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        // Body OBLIGATOIRE. Storage est servi par Fastify, qui refuse toute
        // requête annonçant 'application/json' avec un corps vide :
        //   400 "Body cannot be empty when content-type is set to
        //        'application/json'"
        // Cet endpoint n'attend aucun paramètre, d'où le '{}'. Sans lui la
        // signature échoue systématiquement et la fonction renvoie 502
        // "signature indisponible" : un symptôme qui ressemble à tort à une
        // clé secrète invalide (une vraie mauvaise clé renverrait 403).
        body: '{}',
        signal: controller.signal,
      }
    );
    if (!res.ok) throw new Error(`storage sign ${res.status}`);
    // Réponse : { url: "/object/upload/sign/artist-photos/<path>?token=..." }
    const data = await res.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Origines autorisées à appeler cette fonction depuis un navigateur. On ne met
// PAS de wildcard (finding M3) : seul le site de prog peut signer un upload.
// (L'auth réelle reste le code Events ; ceci limite juste l'abus cross-origin.)
const ALLOWED_ORIGINS = new Set([
  'https://prog.citizenbar.fr',
  'https://resa-omega.vercel.app',
]);

module.exports = async function handler(req, res) {
  // CORS : on reflète l'origine seulement si elle est dans la liste blanche.
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end('Method Not Allowed');
    return;
  }

  // Garde-fou : sans clé secrète configurée, on ne peut pas signer.
  if (!SUPABASE_SECRET_KEY) {
    console.error('[upload-photo] SUPABASE_SECRET_KEY manquante');
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'upload non configuré' }));
    return;
  }

  try {
    // Lire le corps JSON (Vercel ne parse pas toujours automatiquement).
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') {
      const raw = await new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => resolve(d));
        req.on('error', () => resolve(''));
      });
      body = raw ? JSON.parse(raw) : {};
    }

    const code = String(body.code || '').trim();
    const ext = String(body.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Validation des entrées.
    if (!/^\d{6}$/.test(code)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'code invalide' }));
      return;
    }
    if (!ALLOWED_EXT.has(ext)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'format non supporté (jpg, png, webp)' }));
      return;
    }

    // Vérifier le code Events AVANT de signer quoi que ce soit.
    // Réserve un crédit d'upload (atomique). Refuse si code invalide/scellé OU
    // limite d'uploads atteinte pour ce code (anti-abus C1).
    if (!(await reserveUploadSlot(code))) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'code Events invalide, déjà utilisé, ou trop d\'envois' }));
      return;
    }

    // Nom de fichier UUID (non devinable, non énumérable).
    const normalizedExt = ext === 'jpeg' ? 'jpg' : ext;
    const path = `${uuid()}.${normalizedExt}`;

    const signed = await signUpload(path);

    // Le SDK client (uploadToSignedUrl) attend le "path" et le "token".
    // Le token est dans l'URL renvoyée par Storage (?token=...).
    const token = (signed.url || '').split('token=')[1] || signed.token || '';
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ bucket: BUCKET, path, token, publicUrl }));
  } catch (err) {
    console.error('[upload-photo] erreur:', err && err.message);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'signature indisponible' }));
  }
};
