// Shared visual-PDF preparation for the ingest pipeline.
//
// `prepareVisualPdfChunks` lifts the inline `createCaptioner → parsePdfPages →
// detectVisualCandidates → enrichPagesWithCaptions → buildChunksAndEmbeddings
// → extractPdfTitle` flow out of the CLI's `ingestSingleFile`
// (src/cli/ingest.ts) and the MCP server's `handleIngestFile`
// (src/server/index.ts) into this single dispatch-agnostic helper. Each
// caller keeps ownership of its persistence semantics (delete + insert with
// the CLI's bulk-loop optimize() vs. the MCP server's backup/rollback/optimize
// per call); only the shared "produce chunks + embeddings + title from a PDF
// using VLM captions" computation lives here.
//
// NFR-1 dynamic-import discipline: this module lives under `src/ingest/`,
// which is safe to import statically from dispatch sites. The `pdf-visual`
// package is loaded HERE via a single dynamic `await import('../pdf-visual/index.js')`
// so the default (non-visual) path never pulls VLM code into the bundle.
// AC-001's Proxy sentinel (default-mode invariance witness) continues to
// observe `pdf-visual` untouched as long as the dispatch sites only call into
// `prepareVisualPdfChunks` when `visual === true && isPdf`.

import { basename } from 'node:path'

import type { SemanticChunker, TextChunk } from '../chunker/index.js'
import type { EmbedderInterface } from '../chunker/semantic-chunker.js'
import type { DocumentParser } from '../parser/index.js'
import { extractPdfTitle } from '../parser/title-extractor.js'
import { buildChunksAndEmbeddings } from './compute.js'

/**
 * Minimal parser surface consumed by `prepareVisualPdfChunks`. Only the
 * `parsePdfPages` method is required; we reuse `DocumentParser`'s type so the
 * shape stays in sync automatically when the parser contract evolves (e.g.,
 * a new optional field on `pages[]`). `import type` keeps this a type-only
 * dependency — no runtime import of the parser class and no bundle/NFR-1
 * impact. Both `DocumentParser` (production) and parser mocks satisfy this.
 */
export interface VisualPdfParser {
  parsePdfPages: DocumentParser['parsePdfPages']
}

/**
 * Captioner configuration forwarded verbatim to `pdf-visual.createCaptioner`.
 * Mirrors `CaptionerConfig` from `src/pdf-visual/types.ts` without taking a
 * direct dependency on the dynamically-imported module (NFR-1).
 */
export interface CaptionerConfig {
  modelName: string
  cacheDir: string
  /** Execution device passed through to the captioner model. */
  device?: string | undefined
}

/**
 * Result of the shared visual-PDF computation.
 *
 * - `chunks` and `embeddings` come from `buildChunksAndEmbeddings(...)` on
 *   the joined enriched-page text. They have the same length.
 * - `title` is the resolved display title from `extractPdfTitle(...)`, or
 *   `null` when no title can be derived (matches the existing inline-flow
 *   semantics).
 */
export interface PrepareVisualPdfChunksResult {
  chunks: TextChunk[]
  embeddings: number[][]
  title: string | null
  /**
   * The joined enriched-page text that was fed into the chunker. Exposed so
   * callers can use its length for `metadata.fileSize` (the existing
   * inline-flow contract — the joined text length is the post-enrichment,
   * pre-chunking size, not the on-disk PDF byte size).
   */
  text: string
}

/**
 * Run the visual-PDF enrichment flow end-to-end and return the chunks +
 * embeddings + title for the caller to persist.
 *
 * Steps (matches the inline flow in `ingestSingleFile` and `handleIngestFile`):
 *   1. Dynamic-import `pdf-visual` (NFR-1 discipline — loaded only here).
 *   2. `createCaptioner(captionerConfig)`.
 *   3. `parser.parsePdfPages(filePath, embedder)` → `{ doc, metadataTitle, pages }`.
 *   4. `detectVisualCandidates(pages)`.
 *   5. `enrichPagesWithCaptions(pages, candidates, doc, captioner)`.
 *   6. Join enriched page texts with `\n\n` (DD-documented join).
 *   7. `buildChunksAndEmbeddings(text, null, chunker, embedder)`.
 *   8. `extractPdfTitle(metadataTitle, chunks[0]?.text, basename(filePath),
 *      pages[0]?.page1FontHint)` (matches DD §Title resolution).
 *   9. `doc.destroy()` in `finally` so the mupdf WASM handle is released on
 *      both success and error paths.
 *
 * Empty-chunks case is propagated verbatim: when `chunks.length === 0`, this
 * function returns `{ chunks: [], embeddings: [], title }` and the caller
 * handles the warning/error (CLI: log + skip; MCP: throw McpError).
 *
 * @param filePath        Absolute path to the PDF (caller has already validated).
 * @param parser          Parser instance with `parsePdfPages` (mockable).
 * @param chunker         Semantic chunker instance (owned by the caller).
 * @param embedder        Embedder implementing `EmbedderInterface`.
 * @param captionerConfig modelName + cacheDir + dtype (resolved by the caller).
 */
export async function prepareVisualPdfChunks(
  filePath: string,
  parser: VisualPdfParser,
  chunker: SemanticChunker,
  embedder: EmbedderInterface,
  captionerConfig: CaptionerConfig
): Promise<PrepareVisualPdfChunksResult> {
  // Dynamic import — load-bearing for NFR-1. The default (non-visual) path
  // must never reach a static `pdf-visual` reference; AC-001 Proxy sentinel
  // verifies this. Both former dispatch sites previously held their own
  // dynamic import; consolidating to a single one here preserves the
  // invariant while removing the duplication.
  const pdfVisual = await import('../pdf-visual/index.js')

  const captioner = pdfVisual.createCaptioner(captionerConfig)

  const { doc, metadataTitle, pages } = await parser.parsePdfPages(filePath, embedder)
  try {
    const candidates = pdfVisual.detectVisualCandidates(
      pages.map((p) => ({ pageNum: p.pageNum, stextJson: p.stextJson })),
      doc as Parameters<typeof pdfVisual.detectVisualCandidates>[1]
    )
    const enrichedPages = await pdfVisual.enrichPagesWithCaptions(
      pages,
      candidates,
      // The dynamic import widens the doc type at the boundary; the parser
      // returned a real mupdf `Document` (caller-typed) so this is safe.
      doc as Parameters<typeof pdfVisual.enrichPagesWithCaptions>[2],
      captioner
    )
    const text = enrichedPages
      .map((p) => p.text)
      .filter((t) => t.length > 0)
      .join('\n\n')

    // Chunk + embed once on the joined visual+text content. Title is derived
    // AFTER chunking from `chunks[0]?.text` (DD §Title resolution).
    const { chunks, embeddings } = await buildChunksAndEmbeddings(text, null, chunker, embedder)

    const titleResult = extractPdfTitle(
      metadataTitle,
      chunks[0]?.text,
      basename(filePath),
      pages[0]?.page1FontHint
    )
    const title = titleResult.title || null

    return { chunks, embeddings, title, text }
  } finally {
    // Caller owns `doc` per `parsePdfPages` contract (AC-013) — release the
    // mupdf WASM handle on both success and error paths. Wrap so a destroy
    // failure cannot mask the original try-body error (finally-overrides-try).
    try {
      doc.destroy()
    } catch (destroyErr) {
      const message = destroyErr instanceof Error ? destroyErr.message : String(destroyErr)
      console.warn(`prepareVisualPdfChunks: doc.destroy() failed: ${message}`)
    }
  }
}
