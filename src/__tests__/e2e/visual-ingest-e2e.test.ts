// VLM PDF Enrichment - Service-Integration E2E Test (CI-gated)
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers (cross-process / cross-service correctness):
//   - End-to-end stdio JSON-RPC wiring of the MCP server's `ingest_file` tool
//     with `visual: true`
//   - Real LanceDB persistence of visual-enriched chunks against a temp BASE_DIR
//   - Real VLM model download + load through the captioner code path
// Lane: service-integration-e2e
// Budget Used: 1/2 service-integration-e2e (reserved slot)
//
// Test Type: End-to-end against a running local stack (mcp-local-rag binary
//            spawned via stdio + real LanceDB + real onnx-community/granite-docling-258M-ONNX
//            model). No HTTP service exists in this product — the "service" here is
//            the MCP server itself, exercised through real JSON-RPC over stdio.
//
// Implementation Timing: FINAL phase only. Skipped unless `RUN_E2E=1`. The
// model download is ~150-200MB (DD §NFR-2), so normal CI runs MUST NOT
// trigger it. The CI gate is checked at file-evaluation time so the suite is
// completely absent in default runs.
//
// vi.hoisted note: NOT used in this file. This E2E spawns a real child
// process and uses real LanceDB + real @huggingface/transformers — no module
// mocks. The isolate: false vitest config (vitest.config.mjs:16-18) still
// applies but is not load-bearing here because there are no vi.mock calls.
//
// CI gate:
//   describe.skipIf(process.env['RUN_E2E'] !== '1')(...)
// is the documented pattern; alternatively use vitest's `test.skipIf`. The
// gate also lives in package.json as a dedicated `test:e2e` script so the
// default `pnpm test` never pulls the VLM model.
//
// Reserved-slot justification (DD §Phase 4 wiring + AC-002 + AC-008a real-DB
// observation): the in-process AC-002 test asserts the caption substring in
// chunks returned by a mocked vectorStore; this test asserts the same
// substring is queryable from a REAL LanceDB rows persisted across a real
// process boundary. AC-008 + AC-008a prove cross-caller equivalence and side
// effects in-process; neither proves that the published `mcp-local-rag` binary
// wires the visual path end-to-end against the actual database engine.

import { afterAll, beforeAll, describe, it } from 'vitest'

// ============================================
// CI Gate
// ============================================

const E2E_ENABLED = process.env['RUN_E2E'] === '1'

// ============================================
// Tests
// ============================================

describe.skipIf(!E2E_ENABLED)('VLM PDF Enrichment - service-integration-e2e (RUN_E2E=1)', () => {
  // const testBaseDir = resolve('./tmp/e2e-visual-base')
  // const testDbPath = resolve('./tmp/e2e-visual-db')
  // const testCacheDir = resolve('./tmp/e2e-visual-cache') // shared with embedder per DD §NFR-2
  // const fixturePdf = resolve('./tmp/e2e-visual-base/figure-bearing.pdf')

  beforeAll(async () => {
    // - mkdir testBaseDir, testDbPath, testCacheDir
    // - copy a figure-bearing fixture PDF to testBaseDir
    // - allow up to ~10 minutes for first-run model download (granite-docling
    //   ~150-200MB + the existing embedder Xenova/all-MiniLM-L6-v2 cache miss).
    //   Use a per-suite hookTimeout override.
  }, /* 10 * 60 * 1000 */ 600_000)

  afterAll(async () => {
    // - rm testBaseDir, testDbPath recursive (keep testCacheDir for model reuse
    //   if RUN_E2E_KEEP_CACHE=1)
  })

  // User Journey (CLI-flavored multi-step, service-internal correctness):
  //   1. Spawn `mcp-local-rag` (built binary or `tsx src/cli.ts`) with
  //      BASE_DIR, DB_PATH, CACHE_DIR pointing at temp dirs and stdio piped
  //      so the test can drive JSON-RPC.
  //   2. Send MCP initialize handshake.
  //   3. Call tools/call for `ingest_file` with { filePath, visual: true }.
  //   4. Read back the response — assert chunkCount > 0.
  //   5. Either query_documents with a phrase from the caption or directly
  //      inspect the LanceDB table to assert at least one row contains the
  //      substring `[Visual content on page `.
  //   6. Send MCP shutdown / kill the child cleanly.
  //
  // ROI: 51 (BV:8 × Freq:5 + Legal:0 + Defect:9) — reserved slot for
  //      cross-process + real-DB correctness; the in-process AC-002 test
  //      cannot prove the published binary wires the visual path end-to-end.
  // Verification items:
  //   - Child process exits cleanly (or is killed after the assertions)
  //   - JSON-RPC response to `ingest_file` has chunkCount > 0
  //   - At least one LanceDB row's `text` column contains
  //     `[Visual content on page ` (verified via a direct LanceDB read or
  //     via a follow-up `query_documents` call)
  //   - No stderr lines marked `[VlmError]` (whole-VLM failure would still
  //     succeed per AC-005 but would not produce the substring)
  // @category: service-integration-e2e
  // @lane: service-integration-e2e
  // @dependency: full-system (mcp-local-rag binary via stdio, real LanceDB, real granite-docling-258M model)
  // @complexity: high
  // CI gate: this entire describe block is skipped unless RUN_E2E=1.
  it.todo(
    'User Journey: spawn mcp-local-rag via stdio, call ingest_file with visual: true, real LanceDB persists [Visual content on page ...] chunk'
  )

  // Optional second case (low priority — included only if the first case is
  // stable in CI). Validates that the visual path's failure mode (no model
  // available, or model load fails) gracefully falls back to text-only
  // chunks as AC-005 specifies, observed end-to-end through the real
  // process boundary.
  // ROI: 36 (BV:6 × Freq:4 + Legal:0 + Defect:6) — below threshold,
  //      kept as it.todo for future consideration; not part of the reserved slot.
  // @category: service-integration-e2e
  // @lane: service-integration-e2e
  // @dependency: full-system with simulated VLM failure (e.g., VLM_MODEL_NAME pointing at a non-existent model)
  // @complexity: high
  it.todo(
    'User Journey (fallback): VLM model unavailable → ingest_file with visual: true completes with text-only chunks in real LanceDB'
  )
})
