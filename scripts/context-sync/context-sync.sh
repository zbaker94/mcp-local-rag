#!/usr/bin/env bash
#
# context-sync.sh — Generate & collect ingestible artifacts for the local-rag MCP.
#
# Sweeps one or more SOURCE ROOTS (your repos / monorepos / wikis) and populates
# an OUTPUT directory with markdown/text artifacts so the local-rag index covers
# more than just top-level READMEs.
#
# Produces five artifact groups under OUTPUT/:
#   README/     symlinks -> every README*.md   (named by parent-dir path)
#   Docs/       symlinks -> every other .md/.txt (named by full file path)
#   Code/       symlinks -> every supported source file (named by full file path)
#   Manifests/  generated digests of package.json / pyproject.toml (real files)
#   Structure/  generated file-tree maps per code project (real files)
#
# local-rag ingest accepts .pdf/.docx/.txt/.md plus source code
# (.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.java), which is chunked at AST
# boundaries. Docs/ keeps prose; Code/ links source files directly. This script
# does NOT ingest — it prints the ingest command to run afterwards.
#
# Idempotent: all four output dirs are rebuilt from scratch on every run, so
# stale or broken links are pruned automatically.
#
# Artifact names are namespaced by a per-root LABEL (default: the root's
# basename) so multiple roots never collide. Override a root's label with
# "label=/abs/path".
#
# Usage:
#   context-sync.sh [options] <source-root> [<source-root> ...]
#   context-sync.sh [options] --base-dir <root> [--base-dir <root> ...]
#
# Options:
#   -o, --output DIR       Output dir for artifacts. Default: $PWD/context
#                          (env: CONTEXT_SYNC_OUTPUT)
#       --base-dir ROOT    A source root to sweep (repeatable). Bare positional
#                          args are also treated as source roots.
#       --prune "a b c"    Space-separated dir names to prune everywhere.
#                          (env: CONTEXT_SYNC_PRUNE_DIRS)
#       --txt-prune "a b"  Extra dir names to prune for .txt only (data trees).
#                          (env: CONTEXT_SYNC_TXT_PRUNE_DIRS)
#       --max-txt-bytes N  Max .txt size to include. Default: 65536
#                          (env: CONTEXT_SYNC_MAX_TXT_BYTES)
#       --max-code-bytes N Max source file size to include. Default: 262144
#                          (env: CONTEXT_SYNC_MAX_CODE_BYTES)
#       --code-exts "a b"  Space-separated code extensions to link (no dots).
#                          (env: CONTEXT_SYNC_CODE_EXTS)
#       --groups "a b c"   Artifact groups to (re)generate: "all" or a subset of
#                          {readme docs code manifests structure}. Default: all.
#                          Only the selected groups' output dirs are cleaned, so
#                          a subset run leaves the others' artifacts in place.
#                          (env: CONTEXT_SYNC_GROUPS)
#       --only NAME        Select a single group (repeatable). Sugar for --groups.
#                          e.g. --only code   or   --only docs --only manifests
#   -h, --help             Show this help.
#
# A root may be given as "LABEL=/abs/path" to set its artifact-name prefix
# explicitly (useful when two roots share a basename).
#
# Requires: bash 4+, find, jq (for package.json digests), python3 3.11+
# (for pyproject.toml digests; degrades gracefully if absent).
#
set -euo pipefail

# bash 4+ required (associative arrays). Stock macOS ships bash 3.2 — fail fast
# with a fix hint rather than a cryptic mid-run error.
if (( ${BASH_VERSINFO[0]:-0} < 4 )); then
  echo "error: bash 4+ required (this is ${BASH_VERSION:-unknown})." >&2
  echo "  macOS: 'brew install bash', then run via that bash (e.g. /opt/homebrew/bin/bash $0 ...)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- defaults (env-overridable) --------------------------------------------
OUTPUT="${CONTEXT_SYNC_OUTPUT:-$PWD/context}"
MAX_TXT_BYTES="${CONTEXT_SYNC_MAX_TXT_BYTES:-65536}"
MAX_CODE_BYTES="${CONTEXT_SYNC_MAX_CODE_BYTES:-262144}"

# Source extensions local-rag chunks at AST boundaries (must match its
# SUPPORTED_EXTENSIONS). Override via CONTEXT_SYNC_CODE_EXTS.
DEFAULT_CODE_EXTS="ts tsx mts cts js jsx mjs cjs py java"
CODE_EXTS_STR="${CONTEXT_SYNC_CODE_EXTS:-$DEFAULT_CODE_EXTS}"

# Filename patterns that mark a code file as generated/minified noise.
CODE_NAME_SKIP=(-iname '*.min.js' -o -iname '*.bundle.js' -o -iname '*.d.ts')

# Which artifact groups to (re)generate. "all" or a space-separated subset of:
# readme docs code manifests structure. Only the SELECTED groups' output dirs
# are cleaned/rebuilt, so `--only code` adds/refreshes Code/ while leaving any
# existing Docs/, README/, etc. untouched. --only NAME (repeatable) is sugar.
GROUPS_STR="${CONTEXT_SYNC_GROUPS:-all}"
ONLY_GROUPS=()

DEFAULT_PRUNE="node_modules .git dist build out .next coverage .venv venv \
__pycache__ vendor target .gradle .idea .terraform .pytest_cache extjs"
PRUNE_DIRS_STR="${CONTEXT_SYNC_PRUNE_DIRS:-$DEFAULT_PRUNE}"

DEFAULT_TXT_PRUNE="resources test tests fixtures vault samples sbsamples \
__data__ testdata data JUnitTestCode"
TXT_PRUNE_STR="${CONTEXT_SYNC_TXT_PRUNE_DIRS:-$DEFAULT_TXT_PRUNE}"

# Filename patterns that mark a .txt as generated data rather than prose.
TXT_NAME_SKIP=(-iname '*result*' -o -iname '*whatif*' -o -iname '*output*' \
               -o -iname '*_dump*' -o -iname '*.placeholder.txt' -o -iname '*changelog*')

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; s/^#$//'; }

# --- arg parse -------------------------------------------------------------
ROOT_SPECS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)      OUTPUT="$2"; shift 2;;
    --base-dir)       ROOT_SPECS+=("$2"); shift 2;;
    --prune)          PRUNE_DIRS_STR="$2"; shift 2;;
    --txt-prune)      TXT_PRUNE_STR="$2"; shift 2;;
    --max-txt-bytes)  MAX_TXT_BYTES="$2"; shift 2;;
    --max-code-bytes) MAX_CODE_BYTES="$2"; shift 2;;
    --code-exts)      CODE_EXTS_STR="$2"; shift 2;;
    --groups)         GROUPS_STR="$2"; shift 2;;
    --only)           ONLY_GROUPS+=("$2"); shift 2;;
    -h|--help)        usage; exit 0;;
    --)               shift; while [[ $# -gt 0 ]]; do ROOT_SPECS+=("$1"); shift; done;;
    -*)               echo "error: unknown flag: $1" >&2; usage >&2; exit 2;;
    *)                ROOT_SPECS+=("$1"); shift;;
  esac
done

[[ ${#ROOT_SPECS[@]} -ge 1 ]] || { echo "error: need at least one source root" >&2; usage >&2; exit 2; }

# --- group selection -------------------------------------------------------
ALL_GROUPS=(readme docs code manifests structure)
declare -A WANT=()
if [[ ${#ONLY_GROUPS[@]} -gt 0 ]]; then sel=("${ONLY_GROUPS[@]}")
elif [[ "$GROUPS_STR" == "all" ]]; then sel=("${ALL_GROUPS[@]}")
else read -ra sel <<< "$GROUPS_STR"; fi
for g in "${sel[@]}"; do
  case "$g" in
    readme|docs|code|manifests|structure) WANT[$g]=1;;
    all) for a in "${ALL_GROUPS[@]}"; do WANT[$a]=1; done;;
    *) echo "error: unknown group: '$g' (valid: ${ALL_GROUPS[*]} all)" >&2; exit 2;;
  esac
done
[[ ${#WANT[@]} -ge 1 ]] || { echo "error: no artifact groups selected" >&2; exit 2; }
want() { [[ -n "${WANT[$1]:-}" ]]; }

# --- preflight -------------------------------------------------------------
command -v find >/dev/null || { echo "error: 'find' not found" >&2; exit 1; }
HAVE_JQ=1; HAVE_PY=1
if want manifests; then
  command -v jq >/dev/null || { HAVE_JQ=0; echo "warn: 'jq' not found — package.json digests skipped" >&2; }
  if command -v python3 >/dev/null && python3 -c 'import tomllib' 2>/dev/null; then :; else
    HAVE_PY=0; echo "warn: python3 3.11+ with tomllib not found — pyproject.toml digests skipped" >&2
  fi
fi

# --- prune expressions -----------------------------------------------------
read -ra PRUNE_DIRS <<< "$PRUNE_DIRS_STR"
read -ra TXT_PRUNE_DIRS <<< "$TXT_PRUNE_STR"

prune_expr=()
for d in "${PRUNE_DIRS[@]}"; do prune_expr+=(-path "*/$d/*" -o); done
unset 'prune_expr[${#prune_expr[@]}-1]'   # drop trailing -o

txt_prune_expr=("${prune_expr[@]}")
for d in "${TXT_PRUNE_DIRS[@]}"; do txt_prune_expr+=(-o -path "*/$d/*"); done

# --- code extension match expr ---------------------------------------------
read -ra CODE_EXTS <<< "$CODE_EXTS_STR"
code_name_expr=()
for e in "${CODE_EXTS[@]}"; do code_name_expr+=(-name "*.$e" -o); done
unset 'code_name_expr[${#code_name_expr[@]}-1]'   # drop trailing -o

# --- per-root helpers ------------------------------------------------------
CUR_ROOT=""; CUR_LABEL=""
# rel <abspath> -> path relative to CUR_ROOT (empty string if abspath == root)
rel() { local p="${1#"$CUR_ROOT"}"; printf '%s' "${p#/}"; }
# slug <relpath> -> '/' replaced by '__'
slug() { printf '%s' "${1//\//__}"; }
# nm <relpath> -> label-prefixed slug; root-level rel -> just the label
nm() { local r="$1"; if [[ -z "$r" || "$r" == "." ]]; then printf '%s' "$CUR_LABEL"; else printf '%s__%s' "$CUR_LABEL" "$(slug "$r")"; fi; }
log() { printf '  %s\n' "$*"; }

# safe_name <filename> -> filename capped to a filesystem-safe length. Deeply
# nested paths slug into names exceeding the 255-byte limit (ln fails, file is
# lost). When too long, keep any extension, truncate the stem, and append a
# checksum of the full name to preserve uniqueness + language detection.
MAX_NAME=200
safe_name() {
  local n="$1"
  [[ ${#n} -le $MAX_NAME ]] && { printf '%s' "$n"; return; }
  local ext="" stem="$n"
  case "$n" in *.*) ext=".${n##*.}"; stem="${n%.*}";; esac
  local h; h=$(printf '%s' "$n" | cksum | cut -d' ' -f1)
  local keep=$(( MAX_NAME - ${#ext} - 12 ))
  (( keep < 1 )) && keep=1
  printf '%s-%s%s' "${stem:0:$keep}" "$h" "$ext"
}

sanitize_label() { printf '%s' "${1//[^A-Za-z0-9._-]/-}"; }

# --- clean output (once) — only the SELECTED groups' dirs ------------------
mkdir -p "$OUTPUT"
clean_group() { rm -rf "${OUTPUT:?}/$1"; mkdir -p "$OUTPUT/$1"; }
want readme    && clean_group README
want docs      && clean_group Docs
want code      && clean_group Code
want manifests && clean_group Manifests
want structure && clean_group Structure

declare -A SEEN_LABELS=()
readme_n=0 docs_n=0 code_n=0 man_n=0 struct_n=0

link_doc() { local f="$1" r name; r=$(rel "$f"); name="$(safe_name "$(nm "$r")")"
  # preserve original extension
  ln -sf "$f" "$OUTPUT/Docs/${name}"; docs_n=$((docs_n+1)); }

link_code() { local f="$1" r name; r=$(rel "$f"); name="$(safe_name "$(nm "$r")")"
  # preserve original extension so local-rag detects the language
  ln -sf "$f" "$OUTPUT/Code/${name}"; code_n=$((code_n+1)); }

digest_pkg_json() {  # $1 = abs path to package.json
  local f="$1" r name; r=$(rel "$(dirname "$f")"); [[ -z "$r" ]] && r="(root)"
  name=$(jq -r '.name // "(unnamed)"' "$f" 2>/dev/null || echo "(unparseable)")
  {
    echo "# npm package: $name"; echo
    echo "- **Project path:** \`$r\`"
    echo "- **Source:** \`package.json\`"
    jq -r '"- **Version:** " + (.version // "n/a")' "$f" 2>/dev/null || true
    jq -r 'if (.description // "") != "" then "- **Description:** " + .description else empty end' "$f" 2>/dev/null || true
    jq -r 'if (.main // "") != "" then "- **Entry (main):** `" + .main + "`" else empty end' "$f" 2>/dev/null || true
    echo
    jq -r 'if (.scripts|type=="object" and (.scripts|length>0)) then
             "## Scripts\n" + ([.scripts|to_entries[]|"- `" + .key + "`: `" + (.value|tostring) + "`"]|join("\n"))
           else empty end' "$f" 2>/dev/null || true
    echo
    jq -r 'if (.dependencies|type=="object" and (.dependencies|length>0)) then
             "## Dependencies\n" + ([.dependencies|to_entries[]|"- " + .key + " " + (.value|tostring)]|join("\n"))
           else empty end' "$f" 2>/dev/null || true
    echo
    jq -r 'if (.devDependencies|type=="object" and (.devDependencies|length>0)) then
             "## Dev dependencies\n" + ([.devDependencies|keys[]|"- " + .]|join("\n"))
           else empty end' "$f" 2>/dev/null || true
  } > "$OUTPUT/Manifests/$(safe_name "$(nm "$(rel "$f")").md")"
}

digest_pyproject() {  # $1 = abs path to pyproject.toml
  python3 "$SCRIPT_DIR/_pyproject_digest.py" "$1" "$CUR_ROOT" > "$OUTPUT/Manifests/$(safe_name "$(nm "$(rel "$1")").md")"
}

# --- sweep each root -------------------------------------------------------
for spec in "${ROOT_SPECS[@]}"; do
  if [[ "$spec" == *=* ]]; then CUR_LABEL="${spec%%=*}"; CUR_ROOT="${spec#*=}"; else CUR_ROOT="$spec"; CUR_LABEL="$(basename "$CUR_ROOT")"; fi
  CUR_ROOT="$(cd "$CUR_ROOT" 2>/dev/null && pwd)" || { echo "error: source root not found: $spec" >&2; exit 1; }
  CUR_LABEL="$(sanitize_label "$CUR_LABEL")"
  # de-collide labels
  if [[ -n "${SEEN_LABELS[$CUR_LABEL]:-}" ]]; then
    SEEN_LABELS[$CUR_LABEL]=$(( SEEN_LABELS[$CUR_LABEL] + 1 )); CUR_LABEL="${CUR_LABEL}-${SEEN_LABELS[$CUR_LABEL]}"
  else SEEN_LABELS[$CUR_LABEL]=1; fi

  echo "==> sweeping [$CUR_LABEL] $CUR_ROOT"

  # README symlink farm: name = parent DIR path; root README -> just the label.
  if want readme; then
    while IFS= read -r f; do
      d=$(dirname "$f"); r=$(rel "$d")
      ln -sf "$f" "$OUTPUT/README/$(safe_name "$(nm "$r").md")"; readme_n=$((readme_n+1))
    done < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o -type f -iname 'readme*.md' -print)
  fi

  # Docs symlink farm: non-README .md (no restriction) + .txt (data-pruned, size-capped).
  if want docs; then
    while IFS= read -r f; do link_doc "$f"; done < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o \
               -type f -name '*.md' ! -iname 'readme*.md' -print)
    while IFS= read -r f; do link_doc "$f"; done < <(find "$CUR_ROOT" \( "${txt_prune_expr[@]}" \) -prune -o \
               -type f -name '*.txt' -size "-${MAX_TXT_BYTES}c" ! \( "${TXT_NAME_SKIP[@]}" \) -print)
  fi

  # Code symlink farm: supported source files (noise dirs pruned, size-capped,
  # minified/declaration files skipped). Chunked at AST boundaries by local-rag.
  if want code; then
    while IFS= read -r f; do link_code "$f"; done < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o \
               -type f \( "${code_name_expr[@]}" \) -size "-${MAX_CODE_BYTES}c" \
               ! \( "${CODE_NAME_SKIP[@]}" \) -print)
  fi

  # Manifest digests.
  if want manifests; then
    if [[ $HAVE_JQ -eq 1 ]]; then
      while IFS= read -r f; do digest_pkg_json "$f"; man_n=$((man_n+1)); done \
        < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o -type f -name 'package.json' -print)
    fi
    if [[ $HAVE_PY -eq 1 ]]; then
      while IFS= read -r f; do digest_pyproject "$f"; man_n=$((man_n+1)); done \
        < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o -type f -name 'pyproject.toml' -print)
    fi
  fi

  # Structure maps: one per code project (dir holding package.json or pyproject.toml).
  if want structure; then
    while IFS= read -r proj; do
      r=$(rel "$proj"); disp="$r"; [[ -z "$disp" ]] && disp="(root)"
      {
        echo "# Project structure: $CUR_LABEL/$disp"; echo
        echo "Directory tree (depth 3, noise dirs pruned) of \`$disp\`."; echo
        echo '```'
        # `|| true`: head closes the pipe after 400 lines, SIGPIPE-ing find/sort;
        # under `set -o pipefail` that 141 would otherwise abort the whole script.
        find "$proj" -maxdepth 3 \( "${prune_expr[@]}" -o -name .git \) -prune -o -print \
          | sed "s#^$proj#.#" | sort | head -400 || true
        echo '```'
      } > "$OUTPUT/Structure/$(safe_name "$(nm "$r").md")"
      struct_n=$((struct_n+1))
    done < <(find "$CUR_ROOT" \( "${prune_expr[@]}" \) -prune -o \
               -type f \( -name 'package.json' -o -name 'pyproject.toml' \) -print \
               | while IFS= read -r m; do dirname "$m"; done | sort -u)
  fi
done

log "$readme_n READMEs, $docs_n docs, $code_n code, $man_n manifests, $struct_n structure maps"

# --- summary + ingest hint -------------------------------------------------
echo
echo "Done. Artifact counts under $OUTPUT (* = regenerated this run):"
count_dir() { # $1=dir $2=find-type ; prints count or "-" if dir absent
  [[ -d "$OUTPUT/$1" ]] && find "$OUTPUT/$1" -type "$2" | wc -l | tr -d ' ' || printf -- '-'; }
mark() { want "$1" && printf '*' || printf ' '; }
printf '  README/    %s %s\n' "$(count_dir README l)" "$(mark readme)"
printf '  Docs/      %s %s\n' "$(count_dir Docs l)" "$(mark docs)"
printf '  Code/      %s %s\n' "$(count_dir Code l)" "$(mark code)"
printf '  Manifests/ %s %s\n' "$(count_dir Manifests f)" "$(mark manifests)"
printf '  Structure/ %s %s\n' "$(count_dir Structure f)" "$(mark structure)"

# Locate the local-rag CLI relative to this script (scripts/context-sync -> repo root).
DIST="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)/dist/index.js"
[[ -f "$DIST" ]] || DIST="<path-to-mcp-local-rag>/dist/index.js"

echo
echo "Next: ingest the artifacts (symlink targets must resolve under a --base-dir):"
echo
{
  echo "  node \"$DIST\" \\"
  echo "    --db-path ~/.mcp-local-rag/lancedb --cache-dir ~/.mcp-local-rag/models \\"
  echo "    ingest \"$OUTPUT\" \\"
  echo "    --base-dir \"$OUTPUT\" \\"
  for spec in "${ROOT_SPECS[@]}"; do
    p="${spec#*=}"; printf '    --base-dir "%s" \\\n' "$p"
  done
  echo "    --follow-symlinks"
} | sed '$ s/ \\$//'
