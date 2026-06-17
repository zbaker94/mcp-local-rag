#!/usr/bin/env bash
#
# ado-work-item-sync.sh — Export Azure DevOps work items (with comments) to
# markdown for local-rag ingest.
#
# Queries a project for work items of a given type changed within a window,
# fetches each item's fields + full comment thread, and renders one markdown
# file per item. It does NOT ingest — it prints the ingest command at the end.
#
# Auth (in priority order):
#   1. ADO_PAT env var          -> Basic auth (works in CI / headless)
#   2. `az` CLI logged in       -> AAD bearer token for the ADO resource
#
# Usage:
#   ado-work-item-sync.sh --org ORG --project PROJ [options]
#
# Options:
#   --org NAME            ADO org (the dev.azure.com/<NAME> segment).
#                         (env: ADO_ORG)
#   --project NAME        Project name or ID. (env: ADO_PROJECT)
#   --type NAME           Work item type. Default: "Support Ticket".
#                         (env: ADO_WORK_ITEM_TYPE)
#   --since-days N        Include items with ChangedDate within N days.
#                         Default: 365. (env: ADO_SINCE_DAYS)
#   --wiql QUERY          Full WIQL override (must SELECT [System.Id]).
#                         Takes precedence over --type/--since-days.
#                         (env: ADO_WIQL)
#   --output DIR          Output dir for markdown. Default: $PWD/work-items
#                         (env: ADO_OUTPUT)
#   --parallel N          Concurrent comment fetches. Default: 8.
#   -h, --help            Show this help.
#
# Requires: bash 4+, curl, jq, python3 3.11+, and either ADO_PAT or `az`.
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- defaults (env-overridable) --------------------------------------------
ORG="${ADO_ORG:-}"
PROJECT="${ADO_PROJECT:-}"
WIT_TYPE="${ADO_WORK_ITEM_TYPE:-Support Ticket}"
SINCE_DAYS="${ADO_SINCE_DAYS:-365}"
WIQL="${ADO_WIQL:-}"
OUTPUT="${ADO_OUTPUT:-$PWD/work-items}"
PARALLEL=8
ADO_RESOURCE="499b84ac-1321-427f-aa17-267ca6975798"  # Azure DevOps app ID (constant)

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; s/^#$//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org)        ORG="$2"; shift 2;;
    --project)    PROJECT="$2"; shift 2;;
    --type)       WIT_TYPE="$2"; shift 2;;
    --since-days) SINCE_DAYS="$2"; shift 2;;
    --wiql)       WIQL="$2"; shift 2;;
    --output)     OUTPUT="$2"; shift 2;;
    --parallel)   PARALLEL="$2"; shift 2;;
    -h|--help)    usage; exit 0;;
    *)            echo "error: unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

[[ -n "$ORG"     ]] || { echo "error: --org (or ADO_ORG) required" >&2; exit 2; }
[[ -n "$PROJECT" ]] || { echo "error: --project (or ADO_PROJECT) required" >&2; exit 2; }
command -v curl >/dev/null || { echo "error: curl not found" >&2; exit 1; }
command -v jq   >/dev/null || { echo "error: jq not found" >&2; exit 1; }
python3 -c 'import tomllib' 2>/dev/null || true  # render needs 3.x; tomllib not required here
command -v python3 >/dev/null || { echo "error: python3 not found" >&2; exit 1; }

# --- auth header -----------------------------------------------------------
if [[ -n "${ADO_PAT:-}" ]]; then
  AUTH="Authorization: Basic $(printf ':%s' "$ADO_PAT" | base64 | tr -d '\n')"
  echo "auth: PAT"
elif command -v az >/dev/null && TOK=$(az account get-access-token --resource "$ADO_RESOURCE" --query accessToken -o tsv 2>/dev/null) && [[ -n "$TOK" ]]; then
  AUTH="Authorization: Bearer $TOK"
  echo "auth: az AAD token"
else
  echo "error: no auth — set ADO_PAT or log in with 'az login'" >&2; exit 1
fi

API="https://dev.azure.com/$ORG"
PROJ_ENC="${PROJECT// /%20}"
OUT_FIELDS='["System.Title","System.WorkItemType","System.State","System.Reason","System.AreaPath","System.IterationPath","System.AssignedTo","System.CreatedBy","System.CreatedDate","System.ChangedDate","System.Tags","System.Description","Microsoft.VSTS.Common.AcceptanceCriteria","Microsoft.VSTS.Common.ClosedDate","Microsoft.VSTS.Common.Priority","Microsoft.VSTS.Common.Severity","Microsoft.VSTS.TCM.ReproSteps"]'

WORK="$(mktemp -d)"; WI="$WORK/wi"; CM="$WORK/cm"; mkdir -p "$WI" "$CM" "$OUTPUT"
trap 'rm -rf "$WORK"' EXIT

# --- 1. WIQL -> ids --------------------------------------------------------
if [[ -z "$WIQL" ]]; then
  WIQL="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${WIT_TYPE}' AND [System.ChangedDate] >= @today - ${SINCE_DAYS} ORDER BY [System.ChangedDate] ASC"
fi
echo "==> querying: $WIT_TYPE in '$PROJECT' (changed <= ${SINCE_DAYS}d)"
qbody=$(jq -n --arg q "$WIQL" '{query:$q}')
curl -sf -H "$AUTH" -H "Content-Type: application/json" -d "$qbody" \
  "$API/$PROJ_ENC/_apis/wit/wiql?api-version=7.1" \
  | jq -r '.workItems[].id' > "$WORK/ids.txt"
mapfile -t IDS < "$WORK/ids.txt"
echo "    ${#IDS[@]} items"
[[ ${#IDS[@]} -gt 0 ]] || { echo "nothing to do"; exit 0; }

# --- 2. batch fields (200 max per call) ------------------------------------
echo "==> fetching fields"
i=0
while [[ $i -lt ${#IDS[@]} ]]; do
  chunk=("${IDS[@]:$i:200}")
  idjson=$(printf '%s\n' "${chunk[@]}" | jq -R 'tonumber' | jq -s '.')
  body=$(jq -n --argjson ids "$idjson" --argjson fields "$OUT_FIELDS" '{ids:$ids,fields:$fields,"$expand":"none"}')
  curl -sf -H "$AUTH" -H "Content-Type: application/json" -d "$body" \
    "$API/$PROJ_ENC/_apis/wit/workitemsbatch?api-version=7.1" \
    | jq -c '.value[]' | while IFS= read -r line; do
        id=$(jq -r '.id' <<<"$line"); printf '%s' "$line" > "$WI/$id.json"
      done
  i=$((i+200))
done

# --- 3. comments (parallel) ------------------------------------------------
echo "==> fetching comments (P=$PARALLEL)"
export API PROJ_ENC AUTH CM
fetch_comments() {
  curl -sf -H "$AUTH" "$API/$PROJ_ENC/_apis/wit/workItems/$1/comments?api-version=7.1-preview.3" > "$CM/$1.json" || echo '{"comments":[]}' > "$CM/$1.json"
}
export -f fetch_comments
printf '%s\n' "${IDS[@]}" | xargs -P "$PARALLEL" -I{} bash -c 'fetch_comments "$@"' _ {}

# --- 4. render -------------------------------------------------------------
echo "==> rendering markdown -> $OUTPUT"
n=0
for id in "${IDS[@]}"; do
  [[ -f "$WI/$id.json" ]] || { echo "  WARN no fields for $id" >&2; continue; }
  slug=$(printf '%s' "$WIT_TYPE" | tr '[:upper:] ' '[:lower:]-')
  python3 "$SCRIPT_DIR/render_work_item.py" "$WI/$id.json" "$CM/$id.json" "$OUTPUT/${slug}-${id}.md"
  n=$((n+1))
done
echo "    rendered $n files"

# --- 5. ingest hint --------------------------------------------------------
DIST="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd)/dist/index.js"
[[ -f "$DIST" ]] || DIST="<path-to-mcp-local-rag>/dist/index.js"
echo
echo "Next: ingest into local-rag:"
echo
echo "  node \"$DIST\" \\"
echo "    --db-path ~/.mcp-local-rag/lancedb --cache-dir ~/.mcp-local-rag/models \\"
echo "    ingest \"$OUTPUT\""
