// =====================================================================
// VERCEL FUNCTION — signe un upload de photo d'artiste (3 modules)
// =====================================================================
// Rôle : permettre à un intervenant anonyme d'uploader sa photo dans Supabase
// Storage SANS exposer de secret au navigateur.
//
// Deux régimes d'autorisation, selon le module appelant :
//   - Events            : un CODE DJ à 6 chiffres, qui vaut autorisation et
//                         porte son propre compteur (5 uploads max par code).
//   - Radio Campus / OP : aucun code (formulaire ouvert à tous), donc quota
//                         par IP (10 par heure, cf. upload-quota-2026-09.sql).
//
// Flux (signed upload URL, approche recommandée par Supabase) :
//   1. Le navigateur POST { code, ext } ici — `code` absent pour RC et OP.
//   2. La fonction AUTORISE : avec code, ev_can_upload le valide et décompte un
//      crédit ; sans code, upload_quota_take décompte un crédit d'IP. Refus ->
//      403 (code) ou 429 (quota), et aucune signature n'est émise.
//   3. La fonction génère un nom de fichier UUID (non devinable, non
//      énumérable) et demande à Supabase Storage une signed upload URL, avec la
//      clé SECRÈTE (sb_secret_, uniquement en variable d'env Vercel, JAMAIS
//      côté client ni dans le repo).
//   4. Elle renvoie { path, token, publicUrl } au navigateur, qui uploade le
//      fichier DIRECTEMENT vers Storage via uploadToSignedUrl (sans clé).
//
// Sécurité : anon n'a aucune policy d'écriture sur le bucket (cf.
// supabase/storage-artist-photos.sql). Le seul moyen d'uploader est de passer
// par cette fonction, qui exige un code Events valide ou un crédit de quota. La clé secrète ne quitte
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

// Consomme un crédit de quota pour cette IP (RPC upload_quota_take).
// Utilisé par les modules SANS code (Radio Campus, Open Platine), dont le
// formulaire est ouvert à tout visiteur : l'IP est le seul identifiant stable
// dont on dispose pour brider une boucle automatisée. Le décompte se fait
// côté Postgres, dans la même transaction, donc sans course entre requêtes.
// L'adresse n'est jamais stockée en clair (empreinte salée par le jour).
async function takeIpQuota(ip) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upload_quota_take`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_ip: ip }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// IP du client. Sur Vercel, x-forwarded-for est renseigné par la plateforme et
// sa PREMIÈRE valeur est l'adresse d'origine (les suivantes sont les proxys
// traversés). On ne lit pas un en-tête que le client pourrait choisir seul.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).split(',')[0].trim();
  return String(req.headers['x-real-ip'] || '').trim();
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

    if (!ALLOWED_EXT.has(ext)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'format non supporté (jpg, png, webp)' }));
      return;
    }

    // DEUX RÉGIMES D'AUTORISATION, selon que le module a un code ou non.
    //
    //   Events        -> un code DJ à 6 chiffres. Le code EST l'autorisation :
    //                    ev_can_upload le valide et décompte un crédit (5 max).
    //   RC / OP       -> aucun code, formulaire ouvert à tout visiteur. On
    //                    retombe sur un quota par IP (upload_quota_take).
    //
    // Un code DJ MAL FORMÉ est refusé (400) plutôt que traité comme une absence
    // de code. Sinon un DJ ayant épuisé les 5 uploads de son code n'aurait qu'à
    // envoyer n'importe quoi à la place pour passer dans la branche « visiteur »
    // et repartir sur le quota d'IP, qui se recharge toutes les heures.
    // Autrement dit : la branche est choisie par la PRÉSENCE du champ, mais son
    // contenu doit être valide pour cette branche.
    if (code) {
      if (!/^\d{6}$/.test(code)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'code invalide' }));
        return;
      }
      if (!(await reserveUploadSlot(code))) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // ev_can_upload renvoie false pour quatre raisons indistinguables ici :
        // code inconnu, code déjà scellé, 5 uploads atteints, ou soirée passée.
        // Le message les couvre toutes plutôt que d'en affirmer une seule — la
        // version précédente accusait le code, ce qui envoyait le DJ (et le
        // débogage) dans la mauvaise direction quand la vraie cause était la date.
        res.end(JSON.stringify({ error: 'upload impossible : code Events invalide ou déjà utilisé, trop d\'envois, ou soirée passée' }));
        return;
      }
    } else {
      const ip = clientIp(req);
      if (!(await takeIpQuota(ip))) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'trop d\'envois depuis cette connexion, réessaie dans une heure' }));
        return;
      }
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
