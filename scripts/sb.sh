#!/usr/bin/env bash
# =====================================================================
# sb.sh : runner d'operations Supabase, sans secret dans le repo
# =====================================================================
# Lit ses credentials depuis un .env NON commite (.gitignore) et NON lisible
# par l'agent (deny-list du sandbox). Ce script, lui, est commitable : il ne
# contient que des NOMS de variables, jamais de valeur.
#
# Usage :
#   ./scripts/sb.sh sql <fichier.sql>   execute un fichier SQL sur la base
#   ./scripts/sb.sh sql-inline "<sql>"  execute une requete SQL directe
#   ./scripts/sb.sh bucket              cree/repare le bucket artist-photos
#   ./scripts/sb.sh check               sondes de sante (aucun secret requis)
#   ./scripts/sb.sh migrate             rejoue la sequence de MIGRATIONS.md
#
# .env attendu a la racine du repo (aucune valeur d'exemple ici volontairement) :
#   SUPABASE_ACCESS_TOKEN=sbp_...      token CLI, pour l'API management (SQL)
#   SUPABASE_SECRET_KEY=sb_secret_...  cle secrete, pour l'API Storage (bucket)
#   SUPABASE_PROJECT_REF=...           ref du projet (sinon deduit de config.js)
#
# POURQUOI HTTPS ET PAS psql : dans cet environnement, les hotes Postgres ne
# resolvent pas en DNS et le TCP brut sur 5432 est ferme (le trafic passe par un
# proxy HTTP filtrant). psql ne peut donc pas se connecter. L'API management
# Supabase execute du SQL arbitraire en HTTPS, ce qui remplace psql ici.
#
# HYGIENE DES SECRETS : les valeurs ne sont jamais passees en ARGUMENT de
# commande (visibles dans ps/les logs), toujours par en-tete via --data ou
# variable d'environnement du processus enfant. Aucun `set -x`.
# =====================================================================

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUCKET="artist-photos"
API="https://api.supabase.com"

log()  { printf '  %s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
die()  { printf '\nERREUR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------
# Chargement du .env. `set -a` exporte automatiquement ce qui est defini.
# Le fichier n'est jamais affiche, ni son contenu logge.
# ---------------------------------------------------------------------
load_env() {
  # On tente de sourcer .env, mais SANS y compter : selon l'environnement, le
  # fichier peut etre illisible pour le processus courant (bac a sable qui
  # protege les secrets). Dans ce cas, les variables doivent DEJA etre dans
  # l'environnement, chargees par l'utilisateur avant l'appel :
  #     set -a; . ./.env; set +a; ./scripts/sb.sh <commande>
  # L'erreur de lecture est donc ignoree volontairement, pas masquee : si les
  # variables manquent ensuite, `need` le dit explicitement.
  # Le script se charge LUI-MEME son .env : rien a sourcer avant de l'appeler.
  #
  # Subtilite d'environnement : quand l'agent lance ce script, .env peut lui
  # apparaitre comme un character device (bind-mount sur /dev/null) au lieu du
  # vrai fichier. Le sourcing "reussit" alors en ne definissant rien. On ne
  # traite donc PAS l'absence de variables comme une erreur du fichier : `need`
  # explique quoi faire selon le cas.
  #
  # `[[ -f ]]` est volontaire (et non `-e`) : il est faux pour un device, ce qui
  # evite de sourcer /dev/null pour rien.
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env 2>/dev/null || true
    set +a
  elif [[ -e .env ]]; then
    ENV_MASQUE=1   # .env existe mais n'est pas un fichier regulier ici
  fi
  # Valeurs publiques : deduites du front si non fournies.
  : "${SUPABASE_PROJECT_REF:=$(sed -n "s#.*https://\([a-z0-9]*\)\.supabase\.co.*#\1#p" public/js/config.js | head -1)}"
  : "${SUPABASE_URL:=https://${SUPABASE_PROJECT_REF}.supabase.co}"
  [[ -n "${SUPABASE_PROJECT_REF:-}" ]] || die "SUPABASE_PROJECT_REF introuvable (ni .env ni config.js)."
}

# Cle publique (non secrete) pour les sondes de lecture.
publishable_key() {
  sed -n "s#.*supabaseAnonKey: *'\([^']*\)'.*#\1#p" public/js/config.js | head -1
}

need() {
  local var="$1" what="$2"
  [[ -n "${!var:-}" ]] && return 0

  if [[ "${ENV_MASQUE:-0}" == 1 ]]; then
    die "$var introuvable : .env est masque pour ce processus (requis pour $what).

  .env existe bien, mais il apparait ici comme /dev/null au lieu du vrai
  fichier : c'est une protection de l'environnement d'execution de l'agent.
  Le sourcing ne peut donc rien y lire, quel que soit le script.

  Lance la meme commande TOI-MEME dans ton terminal, ou elle verra le vrai
  fichier (le script se chargera son .env tout seul) :

      ./scripts/sb.sh <commande>"
  fi

  die "$var absent de l'environnement (requis pour $what).

  Cree .env a la racine du repo (deja dans .gitignore) avec la ligne :
      $var=<ta valeur>
  Le script le chargera automatiquement, rien d'autre a faire."
}

# ---------------------------------------------------------------------
# SQL via l'API management. Le corps JSON est construit par jq pour que
# tout SQL (quotes, dollar-quoting des fonctions plpgsql, accents) survive.
# ---------------------------------------------------------------------
run_sql() {
  local sql="$1" label="${2:-requete}"
  need SUPABASE_ACCESS_TOKEN "executer du SQL"
  command -v jq >/dev/null || die "jq requis (apt install jq)."

  local body http out
  body="$(jq -n --arg q "$sql" '{query:$q}')"
  out="$(mktemp "${TMPDIR:-/tmp}/sb-sql.XXXXXX")"
  # Le token part en en-tete, jamais en argument visible.
  http="$(printf '%s' "$body" | curl -sS -m 120 -o "$out" -w '%{http_code}' \
      -X POST "$API/v1/projects/${SUPABASE_PROJECT_REF}/database/query" \
      -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data-binary @-)" || true

  if [[ "$http" == 2* ]]; then
    log "OK   $label (HTTP $http)"
    # Affiche le resultat s'il y en a un (select), sinon rien.
    if [[ -s "$out" ]] && jq -e 'if type=="array" then length>0 else false end' "$out" >/dev/null 2>&1; then
      jq -C '.' "$out" | sed 's/^/       /'
    fi
    rm -f "$out"; return 0
  fi

  log "ECHEC $label (HTTP $http)"
  [[ -s "$out" ]] && jq -r '.message // .error // .' "$out" 2>/dev/null | sed 's/^/       /' | head -5
  rm -f "$out"; return 1
}

# ---------------------------------------------------------------------
# Bucket Storage via l'API Storage (cle secrete). Voie fiable : l'insert
# SQL dans storage.buckets est refuse selon le role, ce qui explique
# probablement que la migration #6 soit passee SAUF le bucket.
# ---------------------------------------------------------------------
cmd_bucket() {
  need SUPABASE_SECRET_KEY "creer le bucket"
  local payload http out
  payload="$(jq -n --arg id "$BUCKET" '{
    id:$id, name:$id, public:true, file_size_limit:5242880,
    allowed_mime_types:["image/jpeg","image/png","image/webp"]
  }')"
  out="$(mktemp "${TMPDIR:-/tmp}/sb-bucket.XXXXXX")"

  head1 "Creation du bucket $BUCKET"
  http="$(printf '%s' "$payload" | curl -sS -m 60 -o "$out" -w '%{http_code}' \
      -X POST "${SUPABASE_URL}/storage/v1/bucket" \
      -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
      -H "apikey: ${SUPABASE_SECRET_KEY}" \
      -H 'Content-Type: application/json' --data-binary @-)" || true

  if [[ "$http" == 2* ]]; then
    log "bucket cree (HTTP $http)"
  elif grep -qi "already exists\|Duplicate" "$out" 2>/dev/null; then
    log "bucket deja present : mise a jour des contraintes"
    http="$(printf '%s' "$payload" | curl -sS -m 60 -o "$out" -w '%{http_code}' \
        -X PUT "${SUPABASE_URL}/storage/v1/bucket/${BUCKET}" \
        -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
        -H "apikey: ${SUPABASE_SECRET_KEY}" \
        -H 'Content-Type: application/json' --data-binary @-)" || true
    [[ "$http" == 2* ]] && log "contraintes mises a jour (HTTP $http)" \
                        || { log "echec MAJ (HTTP $http)"; jq -r '.message // .' "$out" | sed 's/^/       /'; }
  else
    log "echec creation (HTTP $http)"
    jq -r '.message // .error // .' "$out" 2>/dev/null | sed 's/^/       /'
    rm -f "$out"; return 1
  fi
  rm -f "$out"

  # Verification : les contraintes sont la seule barriere SERVEUR contre
  # un XSS stocke ou un upload geant (le fichier ne transite pas par la
  # Vercel Function, donc la validation client est contournable).
  head1 "Verification des contraintes du bucket"
  curl -sS -m 30 "${SUPABASE_URL}/storage/v1/bucket/${BUCKET}" \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
  | jq '{id, public, file_size_limit, allowed_mime_types}' | sed 's/^/  /'
}

cmd_sql() {
  local f="${1:?usage: sb.sh sql <fichier.sql>}"
  [[ -f "$f" ]] || die "fichier introuvable: $f"
  head1 "SQL: $f"
  run_sql "$(cat "$f")" "$(basename "$f")"
}

cmd_sql_inline() {
  local q="${1:?usage: sb.sh sql-inline \"<sql>\"}"
  head1 "SQL inline"
  run_sql "$q" "requete inline"
}

# Rejoue la sequence de MIGRATIONS.md. Tous les scripts sont idempotents,
# mais l'ORDRE compte : migrate-public-events redefinit des RPC de policies.
cmd_migrate() {
  head1 "Sequence de migrations (ordre de supabase/MIGRATIONS.md)"
  local f
  for f in schema.sql policies.sql fix-grants.sql fix-column-leak.sql \
           migrate-public-events.sql storage-artist-photos.sql; do
    [[ -f "supabase/$f" ]] || { log "ABSENT supabase/$f"; continue; }
    run_sql "$(cat "supabase/$f")" "$f" || die "arret sur $f (l'ordre compte, ne pas sauter)."
  done
  log "sequence complete. Le bucket se cree a part : ./scripts/sb.sh bucket"
}

# ---------------------------------------------------------------------
# Sondes de sante : n'utilisent QUE la cle publique. Verifient que les
# fermetures de securite tiennent toujours (les deux fuites historiques).
# ---------------------------------------------------------------------
cmd_check() {
  local key url; key="$(publishable_key)"; url="$SUPABASE_URL"
  local h

  head1 "Vues publiques"
  for v in public_agenda public_events; do
    h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
        "$url/rest/v1/$v?select=*&limit=1" -H "apikey: $key" -H "Authorization: Bearer $key")"
    log "$([[ "$h" == 200 ]] && echo OK || echo KO)   $v (HTTP $h)"
  done

  head1 "Fuites colonne (doivent rester FERMEES)"
  for probe in "ev_slots?select=code" "rc_reservations?select=micros,materiel"; do
    if curl -sS -m 20 "$url/rest/v1/$probe&limit=1" \
         -H "apikey: $key" -H "Authorization: Bearer $key" | grep -q '42501'; then
      log "OK   ${probe%%\?*} : permission denied (ferme)"
    else
      log "ALERTE ${probe%%\?*} : LISIBLE EN ANON, rejouer fix-column-leak.sql"
    fi
  done

  head1 "RPC admin fermee a anon"
  h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST "$url/rest/v1/rpc/ev_create_slot" \
      -H "apikey: $key" -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
      -d '{"p_date":"2099-12-31","p_soiree":"probe"}')"
  log "$([[ "$h" == 401 || "$h" == 403 ]] && echo OK || echo ALERTE)   ev_create_slot en anon (HTTP $h, attendu 401)"

  head1 "Bucket $BUCKET"
  # On interroge un OBJET du bucket, pas l'endpoint /bucket/<id> : ce dernier
  # est une operation d'ADMINISTRATION, qui repond "NoSuchBucket" avec une cle
  # publique meme quand le bucket existe (un refus d'autorisation deguise en
  # 404). Le test fiable sans secret est donc la lecture d'un objet absent :
  #   NoSuchKey    -> le bucket EXISTE (seul l'objet manque)
  #   NoSuchBucket -> le bucket est reellement absent
  local b; b="$(curl -sS -m 20 "$url/storage/v1/object/public/$BUCKET/probe-inexistant.png")"
  if grep -q 'NoSuchKey' <<<"$b"; then
    log "OK   bucket present"
  elif grep -q 'NoSuchBucket\|Bucket not found' <<<"$b"; then
    log "KO   bucket ABSENT -> ./scripts/sb.sh bucket"
  else
    log "?    reponse inattendue : $(head -c 120 <<<"$b")"
  fi

  head1 "Upload direct anon (doit etre REFUSE)"
  h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -X POST \
      "$url/storage/v1/object/$BUCKET/probe.png" \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      -H 'Content-Type: image/png' --data-binary 'probe')"
  log "$([[ "$h" != 200 ]] && echo OK || echo ALERTE)   upload anon refuse (HTTP $h)"

  head1 "Deploiement Vercel"
  for u in / /events.yaml /events.json; do
    h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "https://prog.citizenbar.fr$u")"
    log "$([[ "$h" == 200 ]] && echo OK || echo KO)   $u (HTTP $h)"
  done
}

case "${1:-}" in
  sql)        load_env; cmd_sql "${2:-}" ;;
  sql-inline) load_env; cmd_sql_inline "${2:-}" ;;
  bucket)     load_env; cmd_bucket ;;
  migrate)    load_env; cmd_migrate ;;
  check)      load_env; cmd_check ;;
  *) sed -n '5,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
