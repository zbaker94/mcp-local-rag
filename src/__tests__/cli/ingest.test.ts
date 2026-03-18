// CLI Ingest Tests
// Test Type: Unit Test
// Tests runIngest functionality with mocked dependencies

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    // fs/promises
    stat: vi.fn(),
    readdir: vi.fn(),

    // Component instances
    parseFile: vi.fn(),
    parsePdf: vi.fn(),
    chunkText: vi.fn(),
    embedBatch: vi.fn(),
    initialize: vi.fn(),
    deleteChunks: vi.fn(),
    insertChunks: vi.fn(),
    optimize: vi.fn(),
  }
})

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  readdir: mocks.readdir,
}))

// Mock DocumentParser
vi.mock('../../parser/index.js', () => ({
  DocumentParser: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.parseFile = mocks.parseFile
    this.parsePdf = mocks.parsePdf
  }),
  SUPPORTED_EXTENSIONS: new Set(['.pdf', '.docx', '.txt', '.md']),
}))

// Mock SemanticChunker
vi.mock('../../chunker/index.js', () => ({
  SemanticChunker: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.chunkText = mocks.chunkText
  }),
}))

// Mock Embedder
vi.mock('../../embedder/index.js', () => ({
  Embedder: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.embedBatch = mocks.embedBatch
  }),
}))

// Mock VectorStore
vi.mock('../../vectordb/index.js', () => ({
  VectorStore: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.initialize = mocks.initialize
    this.deleteChunks = mocks.deleteChunks
    this.insertChunks = mocks.insertChunks
    this.optimize = mocks.optimize
  }),
}))

// Import after mocks are set up
import { runIngest } from '../../cli/ingest.js'

// ============================================
// Helpers
// ============================================

/**
 * Capture stderr output during a function call.
 * Uses vi.spyOn on console.error since the implementation uses console.error for stderr.
 */
function captureStderr(fn: () => Promise<void>): Promise<{ output: string[]; error: unknown }> {
  const output: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '))
  })

  return fn()
    .then(() => ({ output, error: undefined }))
    .catch((error: unknown) => ({ output, error }))
    .finally(() => {
      spy.mockRestore()
    })
}

/**
 * Create a mock stat result for a file.
 */
function mockFileStat() {
  return { isFile: () => true, isDirectory: () => false }
}

/**
 * Create a mock stat result for a directory.
 */
function mockDirStat() {
  return { isFile: () => false, isDirectory: () => true }
}

/**
 * Set up default successful mocks for single file ingestion.
 */
function setupSuccessfulIngestion() {
  mocks.parseFile.mockResolvedValue({ content: 'parsed text content', title: 'Test Title' })
  mocks.chunkText.mockResolvedValue([
    { text: 'chunk 1', index: 0 },
    { text: 'chunk 2', index: 1 },
  ])
  mocks.embedBatch.mockResolvedValue([
    [0.1, 0.2],
    [0.3, 0.4],
  ])
  mocks.deleteChunks.mockResolvedValue(undefined)
  mocks.insertChunks.mockResolvedValue(undefined)
  mocks.initialize.mockResolvedValue(undefined)
  mocks.optimize.mockResolvedValue(undefined)
}

// ============================================
// Tests
// ============================================

describe('CLI ingest', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Mock process.exit to throw so we can catch it
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  // --------------------------------------------
  // Single file ingest
  // --------------------------------------------
  it('should parse, chunk, embed, delete, insert, and optimize once for a single file', async () => {
    // Arrange
    const filePath = '/tmp/test/document.md'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: process.exit(0) was called
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    // Assert: output shows success
    const joined = output.join('\n')
    expect(joined).toContain('OK (2 chunks)')
    expect(joined).toContain('Succeeded: 1')
    expect(joined).toContain('Failed:    0')
    expect(joined).toContain('Total chunks: 2')
  })

  // --------------------------------------------
  // Directory ingest
  // --------------------------------------------
  it('should recursively find supported files and ingest all when given a directory', async () => {
    // Arrange: first stat call for path validation, second for collectFiles
    const dirPath = '/tmp/test/docs'
    mocks.stat
      .mockResolvedValueOnce(mockDirStat()) // path validation in runIngest
      .mockResolvedValueOnce(mockDirStat()) // stat in collectFiles

    mocks.readdir.mockResolvedValue([
      { name: 'file1.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'file2.txt', parentPath: '/tmp/test/docs/sub', isFile: () => true },
      { name: 'subdir', parentPath: '/tmp/test/docs', isFile: () => false },
    ])

    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: process.exit(0)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    // Assert: both files processed, optimize called once
    const joined = output.join('\n')
    expect(joined).toContain('[1/2]')
    expect(joined).toContain('[2/2]')
    expect(joined).toContain('Succeeded: 2')
    expect(joined).toContain('Total chunks: 4')
  })

  // --------------------------------------------
  // Skip unsupported files
  // --------------------------------------------
  it('should skip unsupported file extensions like .jpg', async () => {
    // Arrange
    const filePath = '/tmp/test/image.jpg'
    mocks.stat.mockResolvedValue(mockFileStat())

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: exit(1) because no supported files found
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Unsupported file extension: .jpg')
  })

  // --------------------------------------------
  // Error skip in bulk
  // --------------------------------------------
  it('should skip failed files and continue processing remaining files', async () => {
    // Arrange
    const dirPath = '/tmp/test/docs'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'good.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'bad.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'good2.txt', parentPath: '/tmp/test/docs', isFile: () => true },
    ])

    mocks.initialize.mockResolvedValue(undefined)
    mocks.optimize.mockResolvedValue(undefined)
    mocks.deleteChunks.mockResolvedValue(undefined)
    mocks.insertChunks.mockResolvedValue(undefined)
    mocks.embedBatch.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    mocks.chunkText.mockResolvedValue([
      { text: 'chunk 1', index: 0 },
      { text: 'chunk 2', index: 1 },
    ])

    // Make the second file (bad.md) fail at parse
    mocks.parseFile
      .mockResolvedValueOnce({ content: 'good content', title: 'Good' })
      .mockRejectedValueOnce(new Error('Parse error: corrupted file'))
      .mockResolvedValueOnce({ content: 'good content 2', title: 'Good2' })

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: exit(1) because of partial failure
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('FAILED: Parse error: corrupted file')
    expect(joined).toContain('Succeeded: 2')
    expect(joined).toContain('Failed:    1')
  })

  // --------------------------------------------
  // Empty directory
  // --------------------------------------------
  it('should exit gracefully with message when directory has no supported files', async () => {
    // Arrange
    const dirPath = '/tmp/test/empty'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'readme.jpg', parentPath: '/tmp/test/empty', isFile: () => true },
    ])

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: exit(1) with "No supported files found"
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('No supported files found')
  })

  // --------------------------------------------
  // Non-existent path
  // --------------------------------------------
  it('should show error message and exit code 1 for non-existent path', async () => {
    // Arrange
    const filePath = '/tmp/test/nonexistent.md'
    mocks.stat.mockRejectedValue(new Error('ENOENT: no such file or directory'))

    // Act
    const { output, error } = await captureStderr(() => runIngest([filePath]))

    // Assert: exit(1) with error message
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')

    const joined = output.join('\n')
    expect(joined).toContain('Error: path does not exist')
    expect(joined).toContain(filePath)
  })

  // --------------------------------------------
  // Partial failure exit code
  // --------------------------------------------
  it('should exit with code 1 when some files fail', async () => {
    // Arrange
    const dirPath = '/tmp/test/docs'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'ok.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'fail.md', parentPath: '/tmp/test/docs', isFile: () => true },
    ])

    setupSuccessfulIngestion()
    // Override: second file fails
    mocks.parseFile
      .mockResolvedValueOnce({ content: 'ok content', title: 'OK' })
      .mockRejectedValueOnce(new Error('Read error'))

    // Act
    const { error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: exit code 1
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(1)')
  })

  // --------------------------------------------
  // All success exit code
  // --------------------------------------------
  it('should exit with code 0 when all files succeed', async () => {
    // Arrange
    const filePath = '/tmp/test/document.txt'
    mocks.stat.mockResolvedValue(mockFileStat())
    setupSuccessfulIngestion()

    // Act
    const { error } = await captureStderr(() => runIngest([filePath]))

    // Assert: exit code 0
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')
  })

  // --------------------------------------------
  // Progress output
  // --------------------------------------------
  it('should output progress in [N/Total] format to stderr', async () => {
    // Arrange
    const dirPath = '/tmp/test/docs'
    mocks.stat.mockResolvedValueOnce(mockDirStat()).mockResolvedValueOnce(mockDirStat())

    mocks.readdir.mockResolvedValue([
      { name: 'a.md', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'b.txt', parentPath: '/tmp/test/docs', isFile: () => true },
      { name: 'c.md', parentPath: '/tmp/test/docs/sub', isFile: () => true },
    ])

    setupSuccessfulIngestion()

    // Act
    const { output, error } = await captureStderr(() => runIngest([dirPath]))

    // Assert: exit(0) for all success
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('process.exit(0)')

    // Assert: progress format [N/Total]
    const joined = output.join('\n')
    expect(joined).toMatch(/\[1\/3\]/)
    expect(joined).toMatch(/\[2\/3\]/)
    expect(joined).toMatch(/\[3\/3\]/)
  })
})
