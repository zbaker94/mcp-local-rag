// VLM PDF Enrichment - Default-Mode Invariance Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-001 (default-mode unchanged + NFR-1 sentinel)
// Test Type: Integration Test (in-process cli ingest dispatch)
// Implementation Timing: Phase 4 (alongside dispatch-site wiring)
//
// Budget Used: 1/3 integration (this file)
// Lane: integration
//
// vi.hoisted note: This file MUST use vi.hoisted for the pdf-visual Proxy
// sentinel because vitest is configured with isolate: false
// (vitest.config.mjs:16-18) for onnxruntime-node compatibility. Without
// vi.hoisted the sentinel state may leak across files. The Proxy sentinel
// installed here MUST NOT leak to ingest-visual.test.ts — that file installs
// its own real-shaped mock; see DD §Testing Strategy → NFR-1 probe.

import { beforeEach, describe, it } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================
//
// NFR-1 negative sentinel: any property access on src/pdf-visual/index.js
// flips `accessed.touched` to true. The default-mode path must never reach
// this object. See DD §Integration Points → "src/pdf-visual/* import
// discipline (normative)" — dispatch sites use dynamic import only when
// args.visual === true && filePath.endsWith('.pdf').

// const accessed = vi.hoisted(() => ({ touched: false }))
//
// vi.mock('../../pdf-visual/index.js', () => {
//   return new Proxy(
//     {},
//     {
//       get(_target, prop) {
//         accessed.touched = true
//         return () => {
//           throw new Error(
//             `pdf-visual.${String(prop)} accessed in default-mode ingest`
//           )
//         }
//       },
//     }
//   )
// })
//
// // Standard project mocks (fs/promises, parser, chunker, embedder, vectordb)
// // follow the pattern from src/__tests__/cli/ingest.test.ts:11-79.

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Default Mode (no --visual)', () => {
  beforeEach(() => {
    // accessed.touched = false
    // reset standard mocks
  })

  // AC-001: "With no --visual flag and no `visual` argument, ingesting a PDF
  //         produces chunks identical to the pre-change baseline (same chunk
  //         count, same chunk text rows in order). No VLM model is downloaded.
  //         A vi.mock-installed sentinel for src/pdf-visual/index.ts records
  //         that no export of that module is accessed during the default-mode
  //         ingest call."
  // ROI: 109 (BV:10 × Freq:10 + Legal:0 + Defect:9)
  // Behavior: Ingest PDF without visual flag → chunks match golden +
  //           pdf-visual module is never touched
  // Verification items:
  //   - Resulting chunk text rows equal GOLDEN_CHUNK_TEXTS (committed fixture)
  //   - Chunk count matches the pre-change baseline
  //   - `accessed.touched` is false after the ingest call
  //   - No `from_pretrained` call for VLM_MODEL_NAME observed
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, parser, chunker, embedder, vectorStore (mocked) + pdf-visual (Proxy sentinel)
  // @complexity: medium
  it.todo('AC-001: default-mode ingest produces golden chunks and never touches pdf-visual')

  // AC-001 (NFR-1 strict): even if the file is a PDF that WOULD have visual
  // candidates, the default path must not reach into pdf-visual. This is the
  // adversarial form of the sentinel assertion — a fixture chosen to be the
  // worst case for accidental dynamic import.
  // ROI: 88 (BV:9 × Freq:8 + Legal:0 + Defect:8) — variant of AC-001
  // Behavior: Ingest figure-heavy PDF without visual flag → sentinel stays false
  // @category: core-functionality
  // @lane: integration
  // @dependency: ingestSingleFile, pdf-visual (Proxy sentinel)
  // @complexity: medium
  it.todo(
    'AC-001 (NFR-1 strict): figure-heavy PDF in default mode does not trigger pdf-visual dynamic import'
  )
})
