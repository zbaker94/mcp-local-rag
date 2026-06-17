# context-sync

Generate ingestible artifacts from arbitrary source trees and feed them to the
local-rag MCP index. A single repo's top-level README rarely captures a whole
codebase — `context-sync.sh` sweeps one or more **source roots** and emits
markdown/text the index can actually search.

It produces five artifact groups under an **output** directory:

| Group        | Contents                                                        | Type        |
|--------------|-----------------------------------------------------------------|-------------|
| `README/`    | every `README*.md`, named by parent-dir path                    | symlinks    |
| `Docs/`      | every other `.md`, plus small `.txt` notes                      | symlinks    |
| `Code/`      | source files (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs/.py/.java`) | symlinks    |
| `Manifests/` | digests of `package.json` / `pyproject.toml`                    | real files  |
| `Structure/` | depth-3 file-tree map per code project                          | real files  |

local-rag ingest accepts `.pdf/.docx/.txt/.md` plus source code (chunked at AST
boundaries), so each artifact is a supported type. Use `--groups` / `--only` to
generate a subset (see below). The script does **not** ingest — it prints the
exact ingest command to run afterward, with your roots pre-filled as `--base-dir`
entries.

## Usage

```bash
scripts/context-sync/context-sync.sh [options] <source-root> [<source-root> ...]
```

Each source root is namespaced by a **label** (default: its basename) so
artifacts from different roots never collide. Override a label with
`label=/abs/path`.

```bash
# Sweep two repos and a wiki into ./context
scripts/context-sync/context-sync.sh \
  -o ~/Documents/Context \
  ~/Repos/my-monorepo \
  wiki=~/Repos/my-project.wiki
```

### Options

| Flag                    | Env var                        | Default          |
|-------------------------|--------------------------------|------------------|
| `-o, --output DIR`      | `CONTEXT_SYNC_OUTPUT`          | `$PWD/context`   |
| `--base-dir ROOT`       | —                              | (positional)     |
| `--prune "a b c"`       | `CONTEXT_SYNC_PRUNE_DIRS`      | noise dir list   |
| `--txt-prune "a b"`     | `CONTEXT_SYNC_TXT_PRUNE_DIRS`  | data dir list    |
| `--max-txt-bytes N`     | `CONTEXT_SYNC_MAX_TXT_BYTES`   | `65536`          |
| `--max-code-bytes N`    | `CONTEXT_SYNC_MAX_CODE_BYTES`  | `262144`         |
| `--code-exts "a b"`     | `CONTEXT_SYNC_CODE_EXTS`       | code ext list    |
| `--groups "a b c"`      | `CONTEXT_SYNC_GROUPS`          | `all`            |
| `--only NAME`           | —                              | (repeatable)     |
| `-h, --help`            | —                              | —                |

Bare positional arguments and `--base-dir` both add source roots; use whichever
reads better.

### Selecting artifact groups

`--groups` (or repeatable `--only`) restricts which of `readme docs code
manifests structure` are generated. **Only the selected groups' output dirs are
cleaned and rebuilt** — the rest are left exactly as they are. This makes it safe
to layer a new group onto an existing output dir:

```bash
# Existing ~/Documents/Context already has Docs/README/Manifests/Structure.
# Add (or refresh) just the code farm from the monorepo — nothing else is touched:
scripts/context-sync/context-sync.sh -o ~/Documents/Context --only code ~/Repos/my-monorepo

# Docs only:
scripts/context-sync/context-sync.sh -o ~/Documents/Context --groups "docs readme" ~/Repos/my-monorepo
```

Then ingest the whole output dir as usual (idempotent per file), or ingest just
the new subdir (e.g. `ingest ~/Documents/Context/Code`).

## Requirements

- `bash` 4+, `find`
- `jq` — for `package.json` digests (skipped with a warning if absent)
- `python3` 3.11+ with stdlib `tomllib` — for `pyproject.toml` digests
  (skipped with a warning if absent)

### Portability notes

- **macOS ships bash 3.2.** The script needs bash 4+ (associative arrays) and
  exits with a hint if run under an older bash. Install a current one with
  `brew install bash` and invoke it explicitly, e.g.
  `/opt/homebrew/bin/bash context-sync.sh ...` (Intel: `/usr/local/bin/bash`).
- Uses only POSIX/BSD-portable `find`/`sed` idioms — no GNU-only flags — so it
  runs the same on macOS and Linux.
- Produces a **symlink farm**. On Linux/macOS/WSL this is fine; native Windows
  (non-WSL) needs Developer Mode or admin for symlinks — run under WSL there.

## Ingesting

The script ends by printing a ready-to-run ingest command. Symlinked targets
resolve outside the output dir, so each root is passed as a `--base-dir` and
`--follow-symlinks` is set:

```bash
node <repo>/dist/index.js \
  --db-path ~/.mcp-local-rag/lancedb --cache-dir ~/.mcp-local-rag/models \
  ingest <output> \
  --base-dir <output> \
  --base-dir <each-source-root> \
  --follow-symlinks
```

Re-ingest is idempotent per file (delete-then-insert) but does **not** remove
chunks for artifacts that disappeared (e.g. after tightening a prune rule). To
purge orphans, list ingested paths and `node dist/index.js delete <path>` any
that no longer exist on disk.

## Notes on portability

- No paths are hardcoded — all roots, the output dir, and prune lists come from
  flags or env vars.
- The `_pyproject_digest.py` helper is resolved relative to the script, not the
  output dir, so the two files can live anywhere together.
- Wikis (e.g. GitHub wiki clones) are just another source root — pass the wiki
  checkout directly instead of symlinking it into the output tree.
