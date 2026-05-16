// AC-013 — `parsePdf` calls `doc.destroy()` exactly once on both the success
// path and the error path; `parsePdfPages` does NOT call `destroy` (caller-
// owned disposal contract per DD § parser.parsePdfPages).
//
// Witness: a `vi.fn()` attached as the `destroy` method of the mock document
// returned by `mupdf.Document.openDocument`. The mock is built per-test so
// each scenario observes its own spy.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentParser, FileOperationError } from '../index'

// ============================================
// Mocks (vi.hoisted — required for `mupdf` per project-wide constraint)
// ============================================

const { mockOpenDocument, mockFilterPageBoundarySentences, mockExtractPdfTitle, mockChunkText } =
  vi.hoisted(() => ({
    mockOpenDocument: vi.fn(),
    mockFilterPageBoundarySentences: vi.fn(),
    mockExtractPdfTitle: vi.fn(),
    mockChunkText: vi.fn(),
  }))

vi.mock('mupdf', () => ({
  Document: { openDocument: mockOpenDocument },
}))

vi.mock('../pdf-filter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../pdf-filter.js')>()
  return {
    ...original,
    filterPageBoundarySentences: mockFilterPageBoundarySentences,
  }
})

vi.mock('../title-extractor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../title-extractor.js')>()
  return {
    ...original,
    extractPdfTitle: mockExtractPdfTitle,
  }
})

vi.mock('../../chunker/index.js', () => ({
  SemanticChunker: class {
    chunkText = mockChunkText
  },
}))

// ============================================
// Test suite
// ============================================

describe('parsePdf destroy lifecycle (AC-013)', () => {
  const testDir = join(process.cwd(), 'tmp', 'test-parsePdf-destroy')
  const maxFileSize = 100 * 1024 * 1024 // 100MB
  const mockEmbedder = { embed: vi.fn() }
  let parser: DocumentParser

  /**
   * Build a mupdf mock document. `destroyFn` is exposed so each test can
   * assert the spy directly. When `pageLoadError` is provided, `loadPage`
   * throws it on the first call — this drives the error path through
   * `extractPdfPages` so the `finally` in `parsePdf` must still run.
   */
  function setupMupdfMock(options: {
    pages: Array<{
      bounds: [number, number, number, number]
      blocks: Array<{
        type: string
        lines?: Array<{ text: string; x: number; y: number; font: { size: number } }>
      }>
    }>
    metadataTitle?: string
    pageLoadError?: Error
  }): { destroyFn: ReturnType<typeof vi.fn> } {
    const destroyFn = vi.fn()
    const mockPages = options.pages.map((pageDef) => {
      const mockStext = {
        asJSON: vi.fn().mockReturnValue(JSON.stringify({ blocks: pageDef.blocks })),
      }
      return {
        getBounds: vi.fn().mockReturnValue(pageDef.bounds),
        toStructuredText: vi.fn().mockReturnValue(mockStext),
      }
    })

    const mockDoc = {
      countPages: vi.fn().mockReturnValue(options.pages.length),
      loadPage: options.pageLoadError
        ? vi.fn().mockImplementation(() => {
            throw options.pageLoadError
          })
        : vi.fn().mockImplementation((i: number) => mockPages[i]),
      getMetaData: vi.fn().mockReturnValue(options.metadataTitle ?? ''),
      destroy: destroyFn,
    }

    mockOpenDocument.mockReturnValue(mockDoc)
    return { destroyFn }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    await mkdir(testDir, { recursive: true })

    parser = new DocumentParser({
      baseDir: testDir,
      maxFileSize,
    })

    // filterPageBoundarySentences: pass through (joins per-page item texts)
    mockFilterPageBoundarySentences.mockImplementation(
      async (pageDataArr: Array<{ items: Array<{ text: string }> }>) =>
        pageDataArr.map((p) => p.items.map((item) => item.text).join('\n'))
    )

    // extractPdfTitle: minimal — return filename-based title (sufficient for AC-013)
    mockExtractPdfTitle.mockImplementation(
      (
        _metadata: string | undefined,
        _chunk: string | undefined,
        fileName: string,
        _fontHint?: { text: string; fontSize: number }
      ) => ({ title: fileName.replace(/\.pdf$/, ''), source: 'filename' as const })
    )

    // SemanticChunker.chunkText: return first text as single chunk
    mockChunkText.mockImplementation(async (text: string) => [{ text, index: 0 }])

    // Dummy PDF file to satisfy validateFilePath + validateFileSize
    await writeFile(join(testDir, 'test.pdf'), 'dummy-pdf-content')
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('should call destroy exactly once on the success path', async () => {
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Hello world', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
    })

    const result = await parser.parsePdf(filePath, mockEmbedder)

    // Sanity check: success path actually ran (content was extracted)
    expect(result.content).toBe('Hello world')
    // AC-013 witness: destroy called exactly once
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  it('should call destroy exactly once on the error path', async () => {
    const filePath = join(testDir, 'test.pdf')
    const pageLoadError = new Error('Simulated per-page extraction failure')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'unused', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
      pageLoadError,
    })

    // Capture the thrown error so we can assert both the surfaced error
    // AND the destroy call count without aborting the test.
    let thrown: unknown
    try {
      await parser.parsePdf(filePath, mockEmbedder)
    } catch (error) {
      thrown = error
    }

    // The error is wrapped in FileOperationError per parsePdf's catch block;
    // assert the wrapped error preserves the original via `cause`.
    expect(thrown).toBeInstanceOf(FileOperationError)
    expect((thrown as FileOperationError).cause).toBe(pageLoadError)
    // AC-013 witness: destroy still called exactly once even when the per-page
    // loop threw. This is the test that would fail if T2.3's `finally` block
    // were removed.
    expect(destroyFn).toHaveBeenCalledTimes(1)
  })

  it('should NOT call destroy from parsePdfPages (caller-owned disposal)', async () => {
    const filePath = join(testDir, 'test.pdf')
    const { destroyFn } = setupMupdfMock({
      pages: [
        {
          bounds: [0, 0, 612, 792],
          blocks: [
            {
              type: 'text',
              lines: [{ text: 'Page content', x: 72, y: 100, font: { size: 12 } }],
            },
          ],
        },
      ],
    })

    const result = await parser.parsePdfPages(filePath, mockEmbedder)

    // Sanity check: parsePdfPages returned the doc handle to the caller
    expect(result.doc).toBeDefined()
    // AC-013 negative assertion: parsePdfPages does NOT call destroy —
    // disposal is the caller's responsibility per DD § parser.parsePdfPages.
    expect(destroyFn).toHaveBeenCalledTimes(0)
  })
})
