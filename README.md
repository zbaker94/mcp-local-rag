# MCP Local RAG

Local retrieval-augmented search over our own documents — specs, wikis, support
tickets, source trees — exposed to AI coding tools over MCP and to the terminal
as a CLI. Everything runs on the machine it's installed on: embeddings,
vector store, search. No documents leave the host, no API keys, no cloud calls
after the one-time model download.

Beyond the RAG engine, the repo carries internal tooling under `scripts/` —
`context-sync` (sweep repos/wikis into the index) and `ado-support-sync` (pull
Azure DevOps work items into the index). Build the repo locally to use them; see
[Setup](#setup).

## What it does

- **Hybrid search.** Vector (semantic) search fused with BM25 keyword search via
  Reciprocal Rank Fusion. Exact technical terms — `useEffect`, `ERR_CONNECTION_REFUSED`,
  class names — rank on exact match, not just semantic proximity. Optional
  cross-encoder reranker for higher precision.
- **Semantic chunking.** Splits documents at topic boundaries (embedding
  similarity) rather than fixed character counts. Source code (TS/JS/Python/Java)
  is chunked at AST boundaries via tree-sitter instead. Markdown code blocks stay
  intact.
- **Relevance-gap filtering.** Groups results by score gaps instead of a fixed
  top-K, so you get fewer but more trustworthy chunks.
- **Two interfaces.** MCP server for AI tools; CLI for scripts and terminal use.
  Optional [Agent Skills](#agent-skills) give assistants prompts for forming
  queries and reading results.

## Setup

Set `BASE_DIR` to the directory you want searchable (or `BASE_DIRS` for multiple
roots — see [Document Roots](#document-roots-base_dir-and-base_dirs)). Only files
under a configured root are readable. **Scope it narrowly** — see
[Security](#security).

```bash
pnpm install
pnpm run build          # compiles TypeScript to dist/
node dist/index.js      # starts the MCP server on stdio; Ctrl+C to exit
```

Register the local build with your client by pointing at the absolute path to
`dist/index.js`:

```bash
# Claude Code
claude mcp add local-rag --scope user \
  --env BASE_DIR=/path/to/your/documents \
  -- node /abs/path/to/mcp-local-rag/dist/index.js
```

```json
// Cursor (~/.cursor/mcp.json)
{
  "mcpServers": {
    "local-rag": {
      "command": "node",
      "args": ["/abs/path/to/mcp-local-rag/dist/index.js"],
      "env": { "BASE_DIR": "/path/to/your/documents" }
    }
  }
}
```

```toml
# Codex (~/.codex/config.toml — note the underscore in mcp_servers)
[mcp_servers.local-rag]
command = "node"
args = ["/abs/path/to/mcp-local-rag/dist/index.js"]

[mcp_servers.local-rag.env]
BASE_DIR = "/path/to/your/documents"
```

Rebuild (`pnpm run build`) and restart the client after changing source. To skip
the build, point the client at the TypeScript source via `tsx` (`command: "tsx"`,
`args: [".../src/index.ts"]`). Avoid `pnpm run watch` for a registered server — it
restarts the process on change and drops the client's stdio connection.

Restart the client, then:

```
You: "Ingest api-spec.pdf"
Assistant: Successfully ingested api-spec.pdf (47 chunks created)

You: "What does the API documentation say about authentication?"
Assistant: Authentication uses OAuth 2.0 with JWT tokens. The flow is in section 3.2...
```

## MCP tools

The server exposes 7 tools: `ingest_file`, `ingest_data`, `query_documents`,
`read_chunk_neighbors`, `list_files`, `delete_file`, `status`.

### Ingesting documents

```
"Ingest the document at /Users/me/docs/api-spec.pdf"
```

Supported: PDF (`mupdf`), DOCX (`mammoth`), TXT, Markdown, and source code
(TS/TSX, JS/JSX, Python, Java). The server extracts text, chunks it, embeds each
chunk locally, and stores vectors in LanceDB. Re-ingesting a file replaces the
old version.

#### PDFs with figures (visual mode)

Opt-in. PDFs with charts, tables, or diagrams can add local VLM-generated
captions to the index, giving visual content some searchable representation in the
same vector + FTS pipeline. Captions are auxiliary text — not image search, not
OCR, not a faithful transcription.

```
MCP:  "Ingest /Users/me/docs/api-spec.pdf with visual: true"
CLI:  node dist/index.js ingest ./docs/spec.pdf --visual
```

Each caption is its own chunk with the envelope `[Visual content on page N: …]`,
alongside the page-body chunks. It flows through the existing embedder and FTS
index — no schema differences, no separate index. Normal ingest does not load the
VLM. Per-page VLM failures are tolerated — that page proceeds with text only.

Two quality profiles, selected per ingest call:

| Profile | Model | Disk (cache) | Per-page inference | Suited for |
|---|---|---|---|---|
| `fast` (default) | `HuggingFaceTB/SmolVLM-256M-Instruct` | ~250 MB | baseline | Light visual indexing, quick first-run. |
| `quality` | `onnx-community/Qwen2.5-VL-3B-Instruct-ONNX` | ~2.9 GB | ~2× `fast` | Figures with in-image text (axis labels, annotations) where caption fidelity matters more than speed. |

Numbers measured on CPU during development against the project's probe PDFs; they
may shift with model updates or differ on your hardware.

```
MCP:  "Ingest /Users/me/docs/research-paper.pdf with visual: true and visualQuality: 'quality'"
CLI:  node dist/index.js ingest ./docs/research-paper.pdf --visual --visual-quality quality
```

`visualQuality` (enum `'fast' | 'quality'`, default `'fast'`) is ignored when
`visual` is false. Both profiles share `CACHE_DIR` (default `./models/`); the
first run on each profile downloads its model.

> **Behavior change from v0.14.0**: captions are emitted as dedicated chunks
> rather than appended to page text before chunking. Side effect:
> `metadata.fileSize` for visual ingests no longer includes caption character
> count — it measures post-extraction body length only. The underlying PDF is
> unchanged.

> **Security note**: visual captions are derived from PDF contents and may
> inherit attacker-controlled text. Treat retrieved chunks as untrusted data, not
> instructions. The `[Visual content on page N: …]` envelope helps consumers
> distinguish caption text from prose. See [Security](#security).

#### Ingesting HTML content

`ingest_data` takes HTML the assistant already fetched (web fetch, curl, browser
tools):

```
"Fetch https://example.com/docs and ingest the HTML"
```

The server extracts main content with Readability (drops nav, ads), converts to
Markdown, and indexes it.

> The server itself does **not** fetch web content — the assistant retrieves it
> and passes the HTML to `ingest_data`. This keeps the server fully local. Respect
> website terms of service and copyright when ingesting external content.

### Searching

```
"What does the API documentation say about authentication?"
"Find information about rate limiting"
```

Hybrid search (semantic + keyword boost). Results include text, source file,
document title, and relevance score. Adjust count with `limit` (1–20, default 10).
Tune ranking with the [Search Tuning](#search-tuning) variables.

### Expanding context around a result

When a result needs surrounding context, `read_chunk_neighbors` reads the chunks
before and after it. Pass the `filePath` and `chunkIndex` from the search result.
The response includes the target chunk (`isTarget: true`) plus neighbors, sorted
by chunk index. Defaults to 2 before and 2 after (up to 50 each).

### Managing files

```
"List all files in configured base directories and their ingested status"
"Delete old-spec.pdf from RAG"
"Show RAG server status"
```

## CLI

Every MCP tool is also a CLI subcommand (`node dist/index.js <subcommand>`):

```bash
node dist/index.js ingest ./docs/                              # bulk ingest
node dist/index.js query "authentication API"                  # search
node dist/index.js read-neighbors --file-path /abs/path.md --chunk-index 5
node dist/index.js list                                        # ingestion status
node dist/index.js status                                      # database stats
node dist/index.js delete ./docs/old.pdf                       # remove a file
node dist/index.js delete --source "https://..."               # remove by source URL
```

`query`, `read-neighbors`, `list`, `status`, and `delete` print JSON to stdout
(pipe to `jq`). `ingest` prints progress to stderr. Global options (`--db-path`,
`--cache-dir`, `--model-name`) go *before* the subcommand; subcommand options go
after. `--help` for details.

> The CLI does **not** read your MCP client config (`mcp.json`, `config.toml`).
> Configure it via flags or environment variables.

> ⚠️ CLI `--model-name` must match the server's `MODEL_NAME`. A different
> embedding model against an existing database produces incompatible vectors and
> silently degrades search quality.

### Multi-root and symlink flags

`--base-dir` is repeatable on `ingest` and `list`; pass it once per root. When any
`--base-dir` is supplied, CLI roots **replace** env-var roots (no merge). The
positional path to `ingest` must sit inside one of the configured roots.

```bash
node dist/index.js ingest --base-dir ./docs --base-dir ./specs ./docs/readme.md
node dist/index.js list --base-dir ./docs --base-dir ./specs
```

`ingest` skips symlinks during directory scans by default. `--follow-symlinks`
walks symlinked directories and ingests symlinked files. A followed link's
**target** is still realpath-checked at read time and rejected if it escapes every
root. To authorize targets *outside* the scanned tree, add `--trusted-dir`
(repeatable) — it widens the read boundary only, is **not** scanned, and is **not**
a valid location for the positional path. `--trusted-dir` requires
`--follow-symlinks`. These flags affect `ingest` only; `list` and `list_files`
always skip symlinks.

```bash
node dist/index.js ingest \
  --base-dir /path/to/curated-links \   # scanned (holds the positional path)
  --trusted-dir /path/to/real-tree \    # link targets allowed here; not scanned
  --follow-symlinks  /path/to/curated-links
```

## Search Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `RAG_HYBRID_WEIGHT` | `0.6` | RRF blend: keyword (FTS) weight. 0 = semantic only, 1 = keyword only. |
| `RAG_RERANK` | (off) | `1`/`true` enables the cross-encoder reranker (re-scores top candidates). Loads a ~80MB model lazily on first query. |
| `RAG_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Override the reranker model. Only used when `RAG_RERANK` is on. |
| `RAG_GROUPING` | (unset) | `similar` for top group only, `related` for top 2 groups. |
| `RAG_MAX_DISTANCE` | (unset) | Filter low-relevance results (e.g. `0.5`). |
| `RAG_MAX_FILES` | (unset) | Limit results to top N files (e.g. `1` for single best file). |

Search is hybrid by default — semantic (vector) and keyword (BM25) fused with RRF.
`RAG_RERANK` adds a second-stage cross-encoder: higher precision, extra per-query
CPU latency.

### Code-focused tuning

For codebases and API specs, raise keyword boost so exact identifiers dominate:

```json
"env": { "RAG_HYBRID_WEIGHT": "0.7", "RAG_GROUPING": "similar" }
```

`0.7` is balanced; `1.0` makes exact matches strongly rerank results. Keyword
boost applies *after* semantic filtering, so it improves precision without
surfacing unrelated matches.

## How it works

1. The parser extracts text by file type (PDF via `mupdf`, DOCX via `mammoth`,
   text/source directly).
2. Source code (TS/JS/Python/Java) is chunked at AST boundaries via tree-sitter;
   large classes split into per-method chunks. Other text is chunked semantically
   — split into sentences, regrouped by embedding similarity at topic boundaries.
   Chunks are typically 500–1000 chars; Markdown code blocks are never split
   mid-block.
3. Each chunk is embedded with Transformers.js (default `all-MiniLM-L6-v2`,
   configurable via `MODEL_NAME`). Vectors are stored in LanceDB, a file-based
   vector DB with no server process.
4. On search: the query is embedded with the same model, vector search finds
   candidates, quality filters apply (distance threshold, grouping), then keyword
   matches boost rankings for exact-term matches.

## Internal sync scripts

Each sweeps a source into ingestible artifacts and prints the exact `ingest`
command — neither ingests itself.

- **`scripts/context-sync/`** — sweep one or more source roots (repos, wikis, doc
  trees) into markdown/text artifacts: READMEs, docs, source files, manifest
  digests, depth-3 file-tree maps. For indexing whole codebases, not single files.
  See [`scripts/context-sync/README.md`](scripts/context-sync/README.md).
- **`scripts/ado-support-sync/`** — export Azure DevOps work items (with full
  comment threads) to one markdown file per item. Built for support-ticket
  corpora; works for any work item type. Idempotent re-ingest makes it safe on a
  schedule. See [`scripts/ado-support-sync/README.md`](scripts/ado-support-sync/README.md).

## Agent Skills

[Agent Skills](https://agentskills.io/) are prompts that help assistants use the
RAG tools consistently — query formulation, result interpretation, ingestion
workflows. Especially useful for CLI-only setups with no MCP server.

```bash
node dist/index.js skills install --claude-code           # project-level
node dist/index.js skills install --claude-code --global  # user-level
node dist/index.js skills install --codex                 # Codex
```

Skills load automatically in most cases (assistants scan skill metadata). To force
it, either ask in natural language ("use the mcp-local-rag skill for this search")
or add to your `AGENTS.md` / `CLAUDE.md`:

```
When using query_documents, ingest_file, or ingest_data tools,
apply the mcp-local-rag skill for better query formulation and result interpretation.
```

## Configuration

The server reads configuration from environment variables only — pass them through
your MCP client's `env` block. The CLI accepts the same env vars plus equivalent
flags (priority: CLI flag > env > default). CLI flags are not accepted on the bare
server launch.

| Environment Variable | CLI Flag | Default | Description |
|---------------------|----------|---------|-------------|
| `BASE_DIR` | `--base-dir` (repeatable) | Current directory | Single document root (security boundary). See [Document Roots](#document-roots-base_dir-and-base_dirs). |
| `BASE_DIRS` | — | (unset) | JSON array of roots (security boundary). Takes precedence over `BASE_DIR`. |
| `DB_PATH` | `--db-path` | `./lancedb/` | Vector database location |
| `CACHE_DIR` | `--cache-dir` | `./models/` | Model cache directory |
| `MODEL_NAME` | `--model-name` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID ([available models](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction)) |
| `MAX_FILE_SIZE` | `--max-file-size` | `104857600` (100MB) | Max file size in bytes (1 to 524288000 / 500MB). Out-of-range or non-numeric → default used, warning surfaced. |
| `RAG_ALLOW_REMOTE_MODELS` | — | (unset → downloads allowed) | Set `false` to run transformers.js offline — models load only from local cache, no Hub download (embedding and visual-caption models). For air-gapped deployments. |
| `CHUNK_MIN_LENGTH` | `--chunk-min-length` | `50` | Minimum chunk length in chars (1–10000) |
| `RAG_DEVICE` | — | `cpu` | Execution device, passed to ONNX Runtime. See [Transformers.js device source](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/utils/devices.js) for backend names. Init failure throws. |
| `RAG_DTYPE` | — | `fp32` | Embedding quantization dtype, passed through (`fp32`, `fp16`, `q8`, `int8`, …). Missing variant throws and names what the model provides. Changing `RAG_DEVICE`/`RAG_DTYPE` changes the embedding space — re-ingest. |
| `RAG_RERANK` | — | (off) | Enable cross-encoder reranker (`1`/`true`). Loads a ~80MB model lazily on first query (uses `RAG_DEVICE`/`RAG_DTYPE`). |
| `RAG_RERANK_MODEL` | — | `Xenova/ms-marco-MiniLM-L-6-v2` | Override reranker model. Only used when `RAG_RERANK` is on. |

Plus the [Search Tuning](#search-tuning) variables above.

**Resolution order:** CLI flags > environment variables > defaults.

**Model choice:**
- Multilingual → `onnx-community/embeddinggemma-300m-ONNX` (100+ languages)
- Scientific papers → `sentence-transformers/allenai-specter` (citation-aware)
- Code → default usually suffices (keyword boost matters more), or `jinaai/jina-embeddings-v2-base-code`

⚠️ Changing `MODEL_NAME` changes embedding dimensions. Delete `DB_PATH` and
re-ingest after switching models.

### Document Roots (`BASE_DIR` and `BASE_DIRS`)

Only files under a configured root are accessible to ingest, list, delete, or
read-neighbor operations. This is the security boundary.

> **Scope the root narrowly.** Every supported file under a root is readable by the
> agent and becomes searchable — its contents are returned in `query_documents`
> results. The default root is the current working directory, so launching from a
> directory that also holds secrets (`.env`, private keys, credentials, `.git`)
> exposes them. Point at a dedicated documents directory. The sensitive-path policy
> blocks system/credential directories (`/etc`, `~/.ssh`, …) from being roots, but
> does **not** filter secret files inside an otherwise-legitimate root.

```bash
# Single root
export BASE_DIR=/Users/me/Documents/work

# Multiple roots — JSON array only
export BASE_DIRS='["/Users/me/Documents/work","/Users/me/Projects/specs"]'
```

Delimiter syntax (`BASE_DIRS=/a:/b`) is intentionally **not** supported (avoids
ambiguity with spaces, colons, commas, Windows paths).

**Resolution order** (highest first): CLI `--base-dir` > `BASE_DIRS` > `BASE_DIR` >
`process.cwd()`. CLI roots replace env roots — never merged. `BASE_DIRS` and
`BASE_DIR` are never merged either; `BASE_DIRS` wins.

**Precedence warning** — when both `BASE_DIRS` and `BASE_DIR` are set (no CLI
`--base-dir`), `BASE_DIR` is ignored and a warning is surfaced (in every MCP tool
response as an extra content block, and on CLI stderr). Unset one to silence it.

**Nested-root pruning** — if one root sits inside another after realpath
resolution, the nested child is dropped to avoid duplicate scan results; a warning
is surfaced. The surviving parent still defines the security boundary.

**Invalid `BASE_DIRS`** — malformed JSON, empty array, or non-string elements →
root-dependent MCP tools return a structured error and CLI subcommands exit
non-zero. No silent fallback to `BASE_DIR` or `cwd`. The `status` tool stays
callable so you can diagnose the config error.

### First run

The embedding model (`all-MiniLM-L6-v2`, ~90MB) downloads on first use (1–2 min),
then works offline. Visual mode downloads its VLM separately on first use (~250 MB
`fast`, ~2.9 GB `quality`).

### Security

- **Path restriction.** Only files within a configured root (`BASE_DIR`, any
  `BASE_DIRS`/`--base-dir` entry) are accessible. Symlinks resolving outside all
  roots, and sibling-prefix paths (e.g. `/foo/barista` for root `/foo/bar`), are
  rejected. `ingest --follow-symlinks` only changes directory *discovery* — it does
  not relax the read-time check. `--trusted-dir` authorizes symlink targets without
  making them scan targets, held to the same sensitive-path policy as `--base-dir`.
- **Local only.** No network requests after model download.
- **Untrusted content.** Ingested document text — especially VLM visual captions,
  which may reproduce attacker-controlled in-image text including `]` that visually
  closes the caption envelope — is data, not instructions. Downstream LLM consumers
  must treat retrieved chunks as untrusted regardless of envelope shape.
- **Model sources** (all official HuggingFace repos):
  - Embedder: [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
  - Visual `fast`: [`HuggingFaceTB/SmolVLM-256M-Instruct`](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct)
  - Visual `quality`: [`onnx-community/Qwen2.5-VL-3B-Instruct-ONNX`](https://huggingface.co/onnx-community/Qwen2.5-VL-3B-Instruct-ONNX)
- **Single-user.** No authentication or access control. Designed for single-user,
  local access. Multi-user would require auth.

### Performance

Measured on MacBook Pro M1 (16GB RAM), Node.js 22, during development:

- **Query**: ~1.2 s for 10,000 chunks (p90 < 3 s)
- **Ingestion (10MB PDF)**: parse ~8s, chunk ~2s, embed ~30s, DB insert ~5s
- **Memory**: ~200MB idle, ~800MB peak (50MB file ingestion)
- **Concurrency**: 5 parallel queries without degradation

## Troubleshooting

**"No results found"** — documents must be ingested first. Run `list` to verify.

**Model download failed** — check connectivity / proxy. The model can be
[downloaded manually](https://huggingface.co/Xenova/all-MiniLM-L6-v2).

**"File too large"** — default limit 100MB. Split the file or raise `MAX_FILE_SIZE`.

**Slow queries** — check chunk count with `status`. Many chunks slow queries;
consider splitting very large files.

**"Path outside BASE_DIR"** — the path must be within a configured root. Use
absolute paths.

**"BASE_DIRS must be a JSON array…"** — `BASE_DIRS` accepts only a JSON array of
one or more non-empty path strings:
- Valid: `'["/Users/me/work","/Users/me/specs"]'`
- Invalid: `/a:/b` (delimiter), `'[]'` (empty), `'["",""]'` (empty element)

The `status` tool stays callable so you can inspect the diagnostic.

**MCP client doesn't see tools** — verify config syntax, fully restart the client
(Cmd+Q on Mac for Cursor), and test directly: `node dist/index.js` should run
without errors.

**Changed embedding model or `RAG_DEVICE`/`RAG_DTYPE`** — embedding space changed.
Delete `DB_PATH` and re-ingest, or search quality degrades silently.

## Development

```bash
pnpm install
pnpm run build         # tsc → dist/ ; entry point dist/index.js
pnpm test              # all tests
pnpm run test:watch    # watch mode
pnpm run type-check    # TypeScript check
pnpm run check:fix     # lint + format
pnpm run check:deps    # circular dependency check
pnpm run check:all     # full quality check
```

### Project structure

```
src/
  index.ts        # entry point (bin) — routes subcommands / starts server
  cli-main.ts     # CLI subcommand dispatcher
  server-main.ts  # MCP server bootstrap
  server/         # MCP tool handlers
  cli/            # CLI subcommands (ingest, query, list, delete, read-neighbors, …)
  ingest/         # shared chunk+embed compute and visual-PDF ingest pipeline
  parser/         # PDF, DOCX, TXT, MD, HTML parsing
  pdf-visual/     # VLM page-captioning subsystem for figure-heavy PDFs
  chunker/        # text splitting
  embedder/       # Transformers.js embeddings
  vectordb/       # LanceDB operations
  utils/          # shared kernel (base-dirs, errors, limits, scan, sensitive-path)
  bin/            # skills installer
  __tests__/      # test suites
scripts/
  context-sync/        # sweep repos/wikis/docs into ingestible artifacts
  ado-support-sync/    # export Azure DevOps work items to markdown
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

MIT licensed. Built on [Model Context Protocol](https://modelcontextprotocol.io/),
[LanceDB](https://lancedb.com/), and [Transformers.js](https://huggingface.co/docs/transformers.js).
