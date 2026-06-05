// =====================================================================
// VERCEL FUNCTION — flux agenda agent-readable (YAML + JSON)
// =====================================================================
// Sert la MEME information que la page HTML humaine (le portail public),
// mais serialisee pour un agent IA : YAML structure par defaut, JSON en
// variante. Pattern "agent-readable web" (style llms.txt) : une URL avec
// extension renvoie de la donnee exploitable par une IA.
//
// Routes servies (voir rewrites dans vercel.json) :
//   /events.yaml  -> YAML  (Content-Type: application/yaml; charset=utf-8)
//   /events.json  -> JSON  (Content-Type: application/json; charset=utf-8)
//   /api/events   -> YAML par defaut, ?format=json pour du JSON
//
// Runtime : Node.js (runtime Vercel Functions par defaut = Fluid Compute,
// PAS Edge). On ne declare aucun `export const config = { runtime: 'edge' }`
// donc Vercel utilise le runtime Node serverless standard. fetch() est
// disponible nativement (Node 18+ sur Vercel), donc ZERO dependance npm.
//
// Source de donnees : la vue Postgres publique `public_events` lue via
// l'API REST PostgREST de Supabase, avec la cle PUBLISHABLE (anon). Cette
// cle est publique par nature et protegee par les RLS. La vue ne contient
// QUE des colonnes publiques (id, module, date, heure, titre, sous_titre,
// styles, format, et les liens promo instagram/soundcloud/photo) et QUE des
// lignes validees a venir ; aucune donnee perso (email/tel/remarques), aucun
// code Events, aucune note interne (micros/materiel). Voir aussi les grants
// colonne sur les tables de base (supabase/fix-column-leak.sql) qui ferment
// l'acces anon direct a code/micros/materiel.
//
// On n'utilise JAMAIS la service_role ici (elle bypasse les RLS).
// =====================================================================

// ---------------------------------------------------------------------
// Config Supabase.
// Par defaut on lit les variables d'environnement Vercel ; a defaut on
// retombe sur les valeurs publiques deja presentes cote front (public/js/
// config.js), car la cle publishable n'est pas un secret. Mettre les env
// vars sur Vercel reste recommande (Settings -> Environment Variables) :
//   SUPABASE_URL              = https://wutzagmeeyzmqgzqaxwy.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  = sb_publishable_xcRt1nCgbYzQroWnmHITKg_teiyMDlh
// Ces deux valeurs etant publiques, le fallback en dur est sans risque ;
// il garantit que la fonction marche meme si l'env n'est pas configuree.
// ---------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://wutzagmeeyzmqgzqaxwy.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_xcRt1nCgbYzQroWnmHITKg_teiyMDlh';

// Libelles lisibles par module (memes valeurs que portal.js cote front).
const MODULE_LABELS = {
  op: 'Open Platine',
  rc: 'Radio Campus',
  ev: 'Events',
};

// =====================================================================
// SERIALISEUR YAML MAISON (sur)
// =====================================================================
// Pourquoi maison : le projet n'a pas de package.json et on veut zero
// dependance. Le perimetre de donnees est connu et etroit (quelques objets
// plats : strings, nombres, dates). Un mini-serialiseur cible suffit.
//
// RISQUE D'INJECTION YAML — et comment on l'empeche :
//   YAML interprete plein de caracteres en debut/dans une valeur :
//     - "- foo"        -> interprete comme un element de liste
//     - "key: value"   -> le ": " casse la paire courante / cree une map
//     - "#commentaire" -> commentaire
//     - "&anchor" "*ref" "!!tag" -> ancres / alias / tags YAML
//     - "@", "`"        -> reserves
//     - "true"/"null"/"123" -> typage implicite (bool/null/number)
//     - retours ligne, tabs, guillemets -> cassent la structure
//   Une valeur attaquante du type  titre: ": evil\n  pwned: 1"  pourrait,
//   sans protection, injecter des cles arbitraires dans le document.
//
// PARADE : on QUOTE SYSTEMATIQUEMENT toute string en double-quotes et on
// echappe le contenu facon JSON (la syntaxe de string double-quote de YAML
// 1.2 est un sur-ensemble compatible JSON : \" \\ \n \t \r \uXXXX...).
// Une string entre doubles quotes correctement echappee ne peut JAMAIS
// etre reinterpretee comme structure YAML : le ": ", le "- ", le "#",
// les "&/*/!" a l'interieur de la quote sont du texte litteral. C'est la
// meme garantie que JSON.stringify d'une string. On ne laisse donc passer
// AUCUNE valeur non quotee provenant de la base.
// ---------------------------------------------------------------------

// Echappe et quote une string facon JSON -> sous-ensemble valide de YAML 1.2.
// JSON.stringify gere deja \" \\ \n \r \t \b \f et les \uXXXX pour tout
// caractere de controle. On force ensuite l'echappement des quelques
// caracteres qui ont un sens en YAML flow mais pas en JSON, par prudence,
// meme si entre double-quotes ils sont deja litteraux.
function yamlQuote(str) {
  // JSON.stringify produit une string entre doubles quotes, deja echappee
  // (guillemets, antislash, \n, \t, \r, controles -> \uXXXX). C'est
  // directement une scalar double-quoted YAML valide.
  return JSON.stringify(String(str));
}

// Serialise une valeur scalaire de facon sure :
//   - null/undefined        -> null (token YAML, pas une string)
//   - number fini           -> tel quel (pas de quote : c'est un nombre voulu)
//   - boolean               -> true/false
//   - tout le reste (string)-> quote + echappe (cf. yamlQuote)
// Les NaN/Infinity sont traites comme null (jamais des tokens YAML invalides).
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Tout ce qui vient de la base est traite comme string quotee.
  return yamlQuote(value);
}

// Serialise un tableau d'objets PLATS en une sequence YAML.
// Forme produite (indentation 2 espaces, tiret de sequence) :
//   items:
//     - module: "op"
//       event_date: "2026-06-18"
//       ...
// Les CLES sont issues d'une whitelist interne (jamais de la donnee externe),
// donc elles n'ont pas besoin d'etre quotees : pas de surface d'injection
// cote cle. Seules les VALEURS proviennent de la base et sont quotees.
function yamlSequenceOfObjects(items, keyOrder) {
  // Cas vide : on renvoie " []" AVEC l'espace de tete. Colle a "events:" cela
  // donne "events: []" (flow sequence vide valide). Sans cet espace,
  // "events:[]" est lu par YAML comme une cle invalide et casse le parsing.
  if (!items.length) return ' []';
  const lines = [];
  for (const obj of items) {
    let first = true;
    for (const key of keyOrder) {
      const rendered = yamlScalar(obj[key]);
      if (first) {
        // Premier champ de l'element : porte le tiret de sequence.
        lines.push(`  - ${key}: ${rendered}`);
        first = false;
      } else {
        // Champs suivants : alignes sous le premier (4 espaces).
        lines.push(`    ${key}: ${rendered}`);
      }
    }
  }
  return '\n' + lines.join('\n');
}

// Construit le document YAML complet (entete de meta + sequence d'events).
function buildYaml(meta, events, keyOrder) {
  const head = [
    `# Citizen Bar - programmation agent-readable`,
    `# Source: ${meta.source}`,
    `# Genere: ${meta.generated_at}`,
    ``,
    `source: ${yamlScalar(meta.source)}`,
    `generated_at: ${yamlScalar(meta.generated_at)}`,
    `timezone: ${yamlScalar(meta.timezone)}`,
    `count: ${yamlScalar(meta.count)}`,
    `events:${yamlSequenceOfObjects(events, keyOrder)}`,
    ``,
  ];
  return head.join('\n');
}

// =====================================================================
// LECTURE SUPABASE (PostgREST, sans dependance)
// =====================================================================
// On compare les deux approches possibles :
//
//   (A) @supabase/supabase-js cote serveur :
//       + ergonomie (.from().select().order()) identique au front.
//       - AJOUTE une dependance npm -> impose un package.json + un install
//         de build sur un projet qui n'en a aucun. Alourdit pour rien.
//
//   (B) fetch() direct sur l'endpoint REST PostgREST :
//       + ZERO dependance (fetch natif Node 18+ sur Vercel).
//       + exactement la meme requete que le SDK genere sous le capot.
//       + on garde le projet "statique + 1 fonction", sans toolchain.
//
// On choisit (B). C'est strictement la requete que loadPublicAgenda() fait
// deja cote client, verifiee en live (HTTP 200).
// ---------------------------------------------------------------------
async function fetchAgenda(todayIso) {
  // PostgREST :
  //   - select : colonnes vitrine enrichies de la vue public_events
  //     (id + liens promo instagram/soundcloud/photo + format). La vue ne
  //     contient QUE des colonnes publiques et QUE des lignes validées ;
  //     aucun contact (email/tel/remarques), aucun code Events, aucune note
  //     interne (micros/materiel) n'y figure (cf. migrate-public-events.sql).
  //   - event_date=gte.<aujourd'hui> : uniquement les events a venir
  //     (defense en profondeur : les contraintes table interdisent deja
  //      l'insertion de dates passees, mais une ligne inseree hier doit
  //      disparaitre du flux aujourd'hui -> on filtre a la lecture).
  //   - order : date croissante puis sort_min (meme tri que le portail)
  const params = new URLSearchParams({
    select: 'id,module,event_date,heure,sort_min,titre,sous_titre,styles,format,instagram,soundcloud,photo',
    event_date: `gte.${todayIso}`,
    order: 'event_date.asc,sort_min.asc',
  });
  const url = `${SUPABASE_URL}/rest/v1/public_events?${params.toString()}`;

  // Timeout dur : on ne laisse pas la fonction pendre si Supabase ne repond pas.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // On ne propage PAS le detail PostgREST au client (fuite interne).
      throw new Error(`upstream ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

// Normalise une ligne brute de la vue en objet de sortie stable et enrichi.
// On ajoute `module_label` (lisible) sans perdre `module` (le code court).
function normalize(row) {
  return {
    id: row.id,                                    // référence stable de l'event
    module: row.module,
    module_label: MODULE_LABELS[row.module] || row.module,
    date: row.event_date,
    time: row.heure,
    title: row.titre,
    subtitle: row.sous_titre || null,
    styles: row.styles || null,                    // style/thème (public)
    format: row.format || null,                    // ex CDJ/USB, vinyl (Events)
    instagram: row.instagram || null,              // lien promo public
    soundcloud: row.soundcloud || null,            // lien promo public
    photo: row.photo || null,                      // URL visuel public
  };
}

// Ordre stable des cles dans la sortie (YAML et JSON).
const OUTPUT_KEY_ORDER = [
  'id', 'module', 'module_label', 'date', 'time', 'title', 'subtitle',
  'styles', 'format', 'instagram', 'soundcloud', 'photo',
];

// =====================================================================
// HANDLER
// =====================================================================
// Determine le format demande a partir de l'URL :
//   - extension .json   -> JSON
//   - extension .yaml/.yml-> YAML
//   - ?format=json|yaml -> override explicite
//   - defaut            -> YAML (cible "agent-readable")
function pickFormat(req) {
  const raw = req.url || '';
  const path = raw.split('?')[0].toLowerCase();
  // Override explicite par query string.
  try {
    const qs = new URLSearchParams(raw.split('?')[1] || '');
    const f = (qs.get('format') || '').toLowerCase();
    if (f === 'json') return 'json';
    if (f === 'yaml' || f === 'yml') return 'yaml';
  } catch (_) {
    /* query mal formee : on ignore et on retombe sur l'extension */
  }
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  return 'yaml';
}

module.exports = async function handler(req, res) {
  // CORS : lecture publique voulue (un agent tiers peut fetcher de partout).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight CORS.
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  // Lecture seule : on refuse tout sauf GET (et HEAD).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  const format = pickFormat(req);

  try {
    // "Aujourd'hui" en heure de Paris (le bar est a Tours). On formate la
    // date civile via Intl pour ne pas decaler a cause d'UTC sur le serveur.
    const todayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()); // en-CA -> "YYYY-MM-DD"

    const rows = await fetchAgenda(todayIso);
    const events = rows.map(normalize);

    const meta = {
      source: 'https://prog.citizenbar.fr/',
      generated_at: new Date().toISOString(),
      timezone: 'Europe/Paris',
      count: events.length,
    };

    // Cache CDN : la prog bouge peu ; on autorise un cache court cote edge
    // avec revalidation en arriere-plan. Cache navigateur desactive pour ne
    // pas servir du perime a un humain qui rafraichit.
    res.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=600'
    );

    if (format === 'json') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ...meta, events }, null, 2));
      return;
    }

    // YAML par defaut.
    const body = buildYaml(meta, events, OUTPUT_KEY_ORDER);
    res.statusCode = 200;
    // application/yaml est le type IANA officiel (RFC 9512, 2024).
    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    res.end(body);
  } catch (err) {
    // ERREUR : message NEUTRE, jamais de detail interne (URL, stack, statut
    // PostgREST...). On logge le detail cote serveur uniquement.
    console.error('[api/events] erreur:', err && err.message);
    res.statusCode = 502;
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'agenda temporairement indisponible' }));
    } else {
      res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
      res.end('error: "agenda temporairement indisponible"\n');
    }
  }
};
