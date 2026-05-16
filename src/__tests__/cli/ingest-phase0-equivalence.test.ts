// VLM PDF Enrichment - Phase 0 Cross-Path Equivalence Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-008 (Phase 0 — same chunk rows via MCP and CLI entry points)
// Test Type: Integration Test (in-process — both dispatch sites called
//            against the same in-memory dependencies)
// Implementation Timing: Phase 0 (must pass before Phase 4 wiring)
//
// Budget Used: 3/3 integration (this file)
// Lane: integration
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// The two dispatch sites (handleIngestFile, ingestSingleFile) share the
// computation layer buildChunksAndEmbeddings (DD §Phase 0). The two
// callers retain their own persistence; this test only asserts the
// chunk-row equivalence, not persistence parity.
//
// IMPORTANT: This file does NOT mock pdf-visual. Phase 0 has no visual
// argument (DD §Phase decomposition — "No visual argument introduced").
// Mocks here are limited to mupdf at the parser boundary (so a fixture PDF
// loads deterministically), chunker, embedder, and vectorStore.

import { describe, it } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// const mocks = vi.hoisted(() => ({
//   // Shared parser fixture: same `{ content, title }` returned to both callers
//   parsePdf: vi.fn(),
//   // Shared chunker/embedder so both callers run identical computation:
//   chunkText: vi.fn(),
//   embedBatch: vi.fn(),
//   // Separate vector stores per call so we can compare inserted-row arrays
//   insertChunksMcp: vi.fn(),
//   insertChunksCli: vi.fn(),
//   deleteChunks: vi.fn(),
//   listFiles: vi.fn().mockResolvedValue([]),
//   search: vi.fn().mockResolvedValue([]),
//   optimize: vi.fn(),
// }))
//
// vi.mock('../../parser/index.js', () => ({
//   DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
//     this.parsePdf = mocks.parsePdf
//   }),
//   SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
// }))
// // chunker, embedder, vectordb mocks follow the precedent at
// // src/__tests__/cli/ingest.test.ts:61-79.

// ============================================
// Tests
// ============================================

describe('VLM PDF Enrichment - Phase 0 Equivalence', () => {
  // AC-008: "A fixture PDF ingested via the MCP handleIngestFile (in-process
  //         call) and the same fixture ingested via the CLI ingestSingleFile
  //         produce identical chunk rows (same count, same `text` per row in
  //         order, same `chunkIndex`, same `fileTitle`). This verifies that
  //         both callers route through the same buildChunksAndEmbeddings
  //         computation and produce equivalent output."
  // ROI: 99 (BV:9 × Freq:10 + Legal:0 + Defect:9)
  // Behavior: Same fixture → handleIngestFile vs ingestSingleFile → identical
  //           chunk rows (chunk text array equality)
  // Verification items:
  //   - Same chunk count from both callers
  //   - chunkIndex sequence identical
  //   - text per row identical (positional equality, not just set equality)
  //   - fileTitle identical
  //   - vectorChunks[*].metadata.fileType identical
  // Note on persistence: this test does NOT assert that MCP-side backup/rollback
  // and optimize happened — those are AC-008a's concern (separate file).
  // @category: integration
  // @lane: integration
  // @dependency: handleIngestFile (server in-process), ingestSingleFile (cli exported), shared parser + chunker + embedder mocks, two vectorStore stubs
  // @complexity: high
  it.todo(
    'AC-008: handleIngestFile and ingestSingleFile produce identical chunk rows for the same fixture PDF'
  )

  // AC-008 (negative — drift sentinel): if either caller bypasses
  // buildChunksAndEmbeddings, the chunk arrays will diverge. This case
  // protects against future regressions where one caller is updated and the
  // other is forgotten.
  // ROI: 56 (BV:7 × Freq:8 + Legal:0 + Defect:0)
  // Behavior: Both callers MUST invoke the shared computation layer once each
  // Verification items:
  //   - buildChunksAndEmbeddings called exactly once per caller
  //   - Called with the same (text, title) tuple
  // @category: integration
  // @lane: integration
  // @dependency: spy on buildChunksAndEmbeddings export
  // @complexity: medium
  it.todo(
    'AC-008 (drift sentinel): both callers invoke buildChunksAndEmbeddings with the same (text, title) tuple'
  )
})
