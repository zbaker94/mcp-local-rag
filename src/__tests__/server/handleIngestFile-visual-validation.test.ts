// VLM PDF Enrichment - handleIngestFile `visual` Runtime Validation Test
// Design Doc: docs/design/vlm-pdf-enrichment-design.md
// Covers: AC-012 (`visual` runtime validation in MCP handler)
// Test Type: Integration Test (server handler input validation)
// Implementation Timing: Phase 4 (alongside MCP schema field addition)
//
// Lane: integration
//
// vi.hoisted note: Required by isolate: false (vitest.config.mjs:16-18).
// Because this test only exercises early input validation, no PDF parse,
// chunker, embedder, or vectorStore call is expected to fire — the
// McpError must be thrown before any of those are touched. Mocks here are
// defensive stubs that fail loudly if reached.

import { describe, it } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

// const failIfCalled = vi.hoisted(() => () =>
//   vi.fn().mockImplementation(() => {
//     throw new Error(
//       'unexpected call: validation should have short-circuited before reaching this'
//     )
//   })
// )
//
// vi.mock('../../parser/index.js', () => ({ /* DocumentParser whose methods are failIfCalled() */ }))
// vi.mock('../../chunker/index.js', () => ({ /* chunkText is failIfCalled() */ }))
// vi.mock('../../embedder/index.js', () => ({ /* embedBatch is failIfCalled() */ }))
// vi.mock('../../vectordb/index.js', () => ({ /* VectorStore methods are failIfCalled() */ }))

// ============================================
// Tests
// ============================================

describe('handleIngestFile - `visual` Runtime Validation (AC-012)', () => {
  // AC-012: "handleIngestFile rejects args.visual values that are neither
  //         undefined nor a boolean with McpError(ErrorCode.InvalidParams,
  //         \"'visual' must be a boolean if provided\"). Tested with
  //         visual: 'true' (string), visual: 1 (number), visual: null."
  // ROI: 49 (BV:7 × Freq:3 + Legal:0 + Defect:7)
  // Behavior: Non-boolean `visual` → McpError(InvalidParams) before any I/O
  // Verification items (one parametrized case per invalid value):
  //   - Error thrown is McpError
  //   - ErrorCode === InvalidParams
  //   - Message includes "'visual' must be a boolean if provided"
  //   - No parser/chunker/embedder/vectorStore method was reached
  // @category: edge-case
  // @lane: integration
  // @dependency: handleIngestFile, defensive stubs (must NOT be called)
  // @complexity: low
  it.todo("AC-012: handleIngestFile throws McpError(InvalidParams) when visual === 'true' (string)")
  it.todo('AC-012: handleIngestFile throws McpError(InvalidParams) when visual === 1 (number)')
  it.todo('AC-012: handleIngestFile throws McpError(InvalidParams) when visual === null')

  // AC-012 (positive — validation does NOT fire for valid values):
  // ROI: 28 (BV:7 × Freq:4 + Legal:0 + Defect:0)
  // Behavior: undefined / true / false → no validation error; the call proceeds
  //           into the dispatch (parser etc. — which may then fail in this test
  //           because the stubs throw, but only AFTER passing validation).
  // Verification items:
  //   - No McpError(InvalidParams) thrown specifically for `visual` shape
  //   - For visual === undefined and visual === false, the default-path stubs
  //     are reached (parser.parsePdf or parseFile)
  //   - For visual === true, the visual-path stubs would be reached (parser.parsePdfPages)
  // @category: edge-case
  // @lane: integration
  // @dependency: handleIngestFile
  // @complexity: low
  it.todo(
    'AC-012 (positive): handleIngestFile does not throw InvalidParams when visual is undefined, true, or false'
  )
})
