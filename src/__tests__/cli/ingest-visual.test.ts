// VLM PDF Enrichment - Visual Mode Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-002 (visual mode produces enriched chunks),
//         AC-004 (per-page VLM failure tolerated),
//         AC-005 (whole-VLM failure → text fallback),
//         AC-006 (non-PDF + visual: true silent coercion),
//         AC-007 (caption embeds correctly through chunker/embedder)
// Test Type: Integration Test (in-process cli ingest dispatch + pdf-visual mocked)
// Implementation Timing: Phase 4 (alongside dispatch-site wiring)
//
// Budget Used: 2/3 integration (this file)
// Lane: integration
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// The mock of '../../pdf-visual/index.js' is a REAL-SHAPED mock — each
// export is a callable that returns plausible values so the visual path
// completes end-to-end. This mock MUST NOT collide with the negative-side
// Proxy sentinel in ingest-default-mode.test.ts; the two live in separate
// files for that reason (DD §Testing Strategy → NFR-1 probe).
//
// @huggingface/transformers is NOT loaded in this file because the captioner
// is invoked only through the mocked pdf-visual surface. mupdf is also not
// loaded — parser.parsePdfPages is mocked at the parser boundary.

import { beforeEach, describe, it } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// const captionerSpy = vi.hoisted(() => ({
//   calls: [] as Array<{ pageNum: number }>,
//   throwOn: new Set<number>(), // pageNums that should throw
//   throwAll: false,
// }))
//
// vi.mock('../../pdf-visual/index.js', () => ({
//   detectVisualCandidates: (pages: Array<{ pageNum: number }>) =>
//     pages.map((p) => ({ pageNum: p.pageNum, isCandidate: p.pageNum === 2 })),
//   enrichPagesWithCaptions: async (
//     pages: Array<{ pageNum: number; text: string }>
//   ) => {
//     for (const p of pages) {
//       if (p.pageNum !== 2) continue
//       captionerSpy.calls.push({ pageNum: p.pageNum })
//       if (captionerSpy.throwAll || captionerSpy.throwOn.has(p.pageNum)) {
//         // orchestrator swallows per-page failures (DD AC-004/AC-005);
//         // the production orchestrator logs a warning and leaves page text
//         // unchanged. The mock mirrors that contract here.
//         continue
//       }
//       p.text = `${p.text}\n\n[Visual content on page ${p.pageNum}: synthetic caption text]`
//     }
//     return pages
//   },
//   createCaptioner: () => ({ caption: async () => 'synthetic caption text' }),
// }))
//
// // Standard mocks (parser.parsePdfPages, parser.parseFile, chunker, embedder,
// // vectorStore) follow the pattern from src/__tests__/cli/ingest.test.ts:11-79.
// // parser.parsePdfPages must return a synthetic 3-page structure with page 2
// // containing an image-block stext entry, plus a stub `doc` whose destroy()
// // is a vi.fn() so caller-owned disposal can be asserted.

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Visual Mode', () => {
  beforeEach(() => {
    // captionerSpy.calls.length = 0
    // captionerSpy.throwOn.clear()
    // captionerSpy.throwAll = false
    // reset standard mocks
  })

  // AC-002: "With visual: true, ingesting a 3-page PDF where page 2 contains
  //         exactly one figure produces ingested chunks whose combined text
  //         contains at least one occurrence of the substring
  //         `[Visual content on page 2: ` followed by caption text and a
  //         closing `]`."
  // ROI: 72 (BV:9 × Freq:8 + Legal:0 + Defect:0) — feature-defining behavior
  // Behavior: visual: true + figure on page 2 → caption substring present in
  //           the chunks inserted into the vector store
  // Verification items:
  //   - At least one inserted chunk.text contains `[Visual content on page 2: `
  //   - The caption text body is recoverable from the combined chunk text
  //   - Pages 1 and 3 produce chunks with no `[Visual content on page` marker
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, parser (parsePdfPages mocked), chunker, embedder, vectorStore (mocked), pdf-visual (real-shaped mock)
  // @complexity: medium
  it.todo('AC-002: visual mode enriches page 2 with caption substring')

  // AC-004: "When the VLM rejects exactly one page (simulated via a mock that
  //         throws on pageNum === 2), the file ingest completes; the failing
  //         page's text is included without a caption; chunks for other
  //         visual-candidate pages contain `[Visual content on page N: ...]`;
  //         a warn-level log line names the failed page."
  // ROI: 48 (BV:8 × Freq:4 + Legal:0 + Defect:8)
  // Behavior: Per-page failure on page 2 + success on others → ingest completes
  // Verification items:
  //   - No thrown error from ingestSingleFile
  //   - Page 2 text appears in chunks but WITHOUT `[Visual content on page 2:`
  //   - Other candidate pages still carry their `[Visual content on page N:`
  //   - Warn-level log line contains the failed pageNum (asserted via console spy)
  // Note: To exercise multiple candidate pages, set the mock so pages 2 AND 3
  //       are candidates and only page 2 throws.
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, pdf-visual (mock with selective throw)
  // @complexity: medium
  it.todo(
    'AC-004: per-page VLM failure on page 2 leaves that page text-only and other pages enriched'
  )

  // AC-005: "When the VLM throws on every visual-candidate page, the file
  //         ingest completes; chunks for the file contain the text-only
  //         content with no `[Visual content on page` substrings; the file's
  //         chunks are present in the index with text-only content; no error
  //         is propagated to the caller."
  // ROI: 64 (BV:8 × Freq:4 + Legal:0 + Defect:8) — explicit graceful-degradation contract
  // Behavior: Whole-VLM failure → fall back to text-only chunks
  // Verification items:
  //   - No thrown error from ingestSingleFile
  //   - No inserted chunk.text contains `[Visual content on page`
  //   - Chunk count > 0 (the text path still produces chunks)
  //   - ingestSingleFile returns the normal chunk-count value
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, pdf-visual (mock with throwAll=true)
  // @complexity: medium
  it.todo('AC-005: whole-VLM failure falls back to text-only chunks without propagating error')

  // AC-006: "Ingesting a .md file with visual: true runs the existing
  //         parseFile() path unchanged and emits no warning. No VLM call is made."
  // ROI: 24 (BV:6 × Freq:4 + Legal:0 + Defect:0)
  // Behavior: visual: true + non-PDF → silent text-only path (no VLM)
  // Verification items:
  //   - captionerSpy.calls.length === 0
  //   - No `[Visual content on page` substring in any chunk
  //   - No warn-level log emitted
  //   - parser.parseFile (NOT parsePdfPages) was the boundary entered
  // @category: edge-case
  // @lane: integration
  // @dependency: ingestSingleFile, parser (parseFile mocked), pdf-visual (real-shaped mock — assert never called)
  // @complexity: low
  it.todo('AC-006: visual: true on .md file silently behaves as visual: false')

  // AC-007: "The VLM-produced caption string passes through chunker.chunkText
  //         without throwing, and the resulting chunks pass through
  //         embedder.embedBatch without throwing. (Verifies the caption is
  //         plain text — no control characters that would break downstream
  //         processing.)"
  // ROI: 35 (BV:7 × Freq:5 + Legal:0 + Defect:0)
  // Behavior: Caption appended → chunker + embedder complete without throwing
  // Verification items:
  //   - chunker.chunkText resolves (not rejects) when given enriched text
  //   - embedder.embedBatch resolves (not rejects) on the chunked output
  //   - Final inserted chunks have non-empty `vector` arrays
  // @category: integration
  // @lane: integration
  // @dependency: ingestSingleFile, real chunker + real embedder (or shape-checked stubs)
  // @complexity: low
  it.todo('AC-007: enriched page text passes through chunker and embedder without error')
})
