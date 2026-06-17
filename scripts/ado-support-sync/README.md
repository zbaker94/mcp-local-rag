# ado-work-item-sync

Export Azure DevOps work items (with their full comment threads) to markdown for
local-rag ingest. Built for support-ticket corpora but works for any work item
type.

`ado-work-item-sync.sh`:

1. Runs a WIQL query for a work item **type** changed within a window (or a full
   WIQL override).
2. Batch-fetches fields, then each item's comments in parallel.
3. Renders one markdown file per item (`render_work_item.py`) — metadata +
   Description / Acceptance criteria / Repro steps + every comment, oldest-first,
   HTML stripped to text.
4. Prints the local-rag ingest command (does not ingest itself).

## Usage

```bash
scripts/ado-support-sync/ado-work-item-sync.sh \
  --org your-org \
  --project "Your Project" \
  --type "Support Ticket" \
  --since-days 365 \
  --output ~/Documents/Context/SupportTickets
```

Then run the ingest command it prints. Re-ingest is idempotent per file
(delete-then-insert), so this is safe to re-run on a schedule.

### Options

| Flag            | Env                    | Default            |
|-----------------|------------------------|--------------------|
| `--org`         | `ADO_ORG`              | (required)         |
| `--project`     | `ADO_PROJECT`          | (required)         |
| `--type`        | `ADO_WORK_ITEM_TYPE`   | `Support Ticket`   |
| `--since-days`  | `ADO_SINCE_DAYS`       | `365`              |
| `--wiql`        | `ADO_WIQL`             | built from type/days |
| `--output`      | `ADO_OUTPUT`           | `$PWD/work-items`  |
| `--parallel`    | —                      | `8`                |

`--wiql` must `SELECT [System.Id]` and overrides `--type`/`--since-days`. Use it
for arbitrary filters, e.g. by area path or state.

## Auth

Tried in order:

1. **`ADO_PAT`** env var — Basic auth. Use in CI / headless. PAT needs
   *Work Items (Read)*.
2. **`az` CLI** — an AAD bearer token for the Azure DevOps resource. Just
   `az login` first.

## Requirements

`bash` 4+, `curl`, `jq`, `python3` 3.x, and either `ADO_PAT` or the `az` CLI.

## Scheduling

To keep the index fresh, wrap the script + the printed ingest command in a cron
job (or a Claude Code routine). `--since-days` bounds each run; idempotent
ingest means re-pulled items just overwrite their chunks.
