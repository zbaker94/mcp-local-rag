// VLM PDF Enrichment - handleIngestFile Side Effects Integration Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-008a (Phase 0 — server wrapper side effects preserved:
//                  McpError on zero chunks, backup/rollback on insert failure,
//                  vectorStore.optimize() invocation on success)
// Test Type: Integration Test (in-process server handler)
// Implementation Timing: Phase 0 (must pass before Phase 4 wiring)
//
// Budget Used: this file is the AC-008a witness — a separate concern from the
// Phase 0 equivalence file (ingest-phase0-equivalence.test.ts). Both files are
// named explicitly by the DD §Existing Codebase Analysis → Implementation Path
// Mapping. Lane: integration.
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// Mocks the parser, chunker, embedder, and vectordb modules using the
// standard project pattern (src/__tests__/cli/ingest.test.ts:11-79).

import { describe, it } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// const mocks = vi.hoisted(() => ({
//   parsePdf: vi.fn(),
//   chunkText: vi.fn(),
//   embedBatch: vi.fn(),
//   listFiles: vi.fn(),
//   search: vi.fn(),
//   deleteChunks: vi.fn(),
//   insertChunks: vi.fn(),
//   optimize: vi.fn(),
// }))
//
// vi.mock('../../parser/index.js', () => ({ /* parser stub returning controllable text/title */ }))
// vi.mock('../../chunker/index.js', () => ({ /* SemanticChunker with mocks.chunkText */ }))
// vi.mock('../../embedder/index.js', () => ({ /* Embedder with mocks.embedBatch */ }))
// vi.mock('../../vectordb/index.js', () => ({
//   VectorStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
//     this.listFiles = mocks.listFiles
//     this.search = mocks.search
//     this.deleteChunks = mocks.deleteChunks
//     this.insertChunks = mocks.insertChunks
//     this.optimize = mocks.optimize
//   }),
// }))

// ============================================
// Tests
// ============================================

describe('handleIngestFile - Phase 0 Wrapper Side Effects (AC-008a)', () => {
  // AC-008a (a): "handleIngestFile continues to throw McpError when the
  //              produced chunk count is 0."
  // ROI: 64 (BV:8 × Freq:8 + Legal:0 + Defect:0)
  // Behavior: chunker returns 0 chunks → McpError thrown, no insert called
  // Verification items:
  //   - Error thrown is an instance of McpError
  //   - ErrorCode is InvalidParams (or whatever the existing code currently uses;
  //     match the pre-Phase-0 behavior verbatim)
  //   - mocks.deleteChunks NOT called
  //   - mocks.insertChunks NOT called
  //   - mocks.optimize NOT called
  // @category: core-functionality
  // @lane: integration
  // @dependency: handleIngestFile, chunker (mocked to return []), vectorStore (mocked)
  // @complexity: low
  it.todo('AC-008a (a): handleIngestFile throws McpError when chunker produces zero chunks')

  // AC-008a (b): "handleIngestFile lists existing chunks (via vectorStore.listFiles
  //              + vectorStore.search) before delete and re-inserts them on
  //              failure (backup/rollback)."
  // ROI: 88 (BV:8 × Freq:10 + Legal:0 + Defect:8) — load-bearing data-integrity behavior
  // Behavior: insertChunks throws on first call (induced failure) → existing
  //           chunks are re-inserted (rollback) → original error re-propagated
  // Verification items:
  //   - Pre-existing chunks retrieved via listFiles + search BEFORE deleteChunks
  //   - deleteChunks called with the target filePath
  //   - First insertChunks call throws (induced)
  //   - SECOND insertChunks call is made with the same chunk rows captured
  //     by listFiles + search (rollback re-insert)
  //   - The original insert error is thrown from handleIngestFile (not swallowed)
  //   - optimize NOT called (because the success path was aborted)
  // @category: core-functionality
  // @lane: integration
  // @dependency: handleIngestFile, vectorStore (insertChunks throws once)
  // @complexity: high
  it.todo(
    'AC-008a (b): handleIngestFile restores previously-indexed chunks when insertChunks fails'
  )

  // AC-008a (c): "handleIngestFile calls vectorStore.optimize() after a
  //              successful insert."
  // ROI: 56 (BV:7 × Freq:8 + Legal:0 + Defect:0)
  // Behavior: Successful ingest → optimize called exactly once after insert
  // Verification items:
  //   - insertChunks resolves successfully
  //   - optimize called exactly once
  //   - optimize call ordering is AFTER insertChunks (use mock.invocationCallOrder)
  //   - MCP response shape is the existing chunkCount JSON envelope
  // @category: core-functionality
  // @lane: integration
  // @dependency: handleIngestFile, vectorStore (success path)
  // @complexity: low
  it.todo('AC-008a (c): handleIngestFile calls vectorStore.optimize() after a successful insert')
})
