// CLI Common Helpers Tests
// Test Type: Unit Test
// Tests createVectorStore and createEmbedder factory functions

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// ============================================
// Mock Setup (vi.hoisted for isolate: false)
// ============================================

const mocks = vi.hoisted(() => {
  return {
    VectorStore: vi.fn(),
    Embedder: vi.fn(),
  }
})

// Mock factories — installed via `vi.doMock` in `beforeAll` and removed via
// `vi.doUnmock` in `afterAll`. See `.claude/skills/project-context/SKILL.md`.

const vectordbFactory = () => ({
  VectorStore: mocks.VectorStore,
})

const embedderFactory = () => ({
  Embedder: mocks.Embedder,
})

const MOCKED_PATHS = ['../../vectordb/index.js', '../../embedder/index.js'] as const

// ============================================
// Imports (dynamic, after vi.doMock in beforeAll)
// ============================================

let createEmbedder: typeof import('../../cli/common.js').createEmbedder
let createVectorStore: typeof import('../../cli/common.js').createVectorStore
type ResolvedGlobalConfig = import('../../cli/options.js').ResolvedGlobalConfig

// ============================================
// Test Data
// ============================================

function makeConfig(overrides: Partial<ResolvedGlobalConfig> = {}): ResolvedGlobalConfig {
  return {
    dbPath: './test-db/',
    cacheDir: './test-cache/',
    modelName: 'Xenova/all-MiniLM-L6-v2',
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('cli/common', () => {
  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../vectordb/index.js', vectordbFactory)
    vi.doMock('../../embedder/index.js', embedderFactory)
    ;({ createEmbedder, createVectorStore } = await import('../../cli/common.js'))
  })

  afterAll(() => {
    for (const p of MOCKED_PATHS) vi.doUnmock(p)
    vi.resetModules()
  })

  describe('createVectorStore', () => {
    afterEach(() => {
      mocks.VectorStore.mockReset()
    })

    it('should construct VectorStore with dbPath from config', () => {
      createVectorStore(makeConfig({ dbPath: '/data/my-db' }))

      expect(mocks.VectorStore).toHaveBeenCalledOnce()
      expect(mocks.VectorStore).toHaveBeenCalledWith({
        dbPath: '/data/my-db',
        tableName: 'chunks',
      })
    })
  })

  describe('createEmbedder', () => {
    const originalDevice = process.env['RAG_DEVICE']
    const originalDtype = process.env['RAG_DTYPE']

    afterEach(() => {
      mocks.Embedder.mockReset()
      if (originalDevice === undefined) {
        delete process.env['RAG_DEVICE']
      } else {
        process.env['RAG_DEVICE'] = originalDevice
      }
      if (originalDtype === undefined) {
        delete process.env['RAG_DTYPE']
      } else {
        process.env['RAG_DTYPE'] = originalDtype
      }
    })

    it('defaults device to cpu when RAG_DEVICE is unset', () => {
      delete process.env['RAG_DEVICE']

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledOnce()
      expect(mocks.Embedder).toHaveBeenCalledWith({
        modelPath: 'custom/model',
        batchSize: 16,
        cacheDir: '/custom/cache',
        device: 'cpu',
      })
    })

    it('passes RAG_DEVICE through to the Embedder', () => {
      process.env['RAG_DEVICE'] = 'webgpu'

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledWith(expect.objectContaining({ device: 'webgpu' }))
    })

    it('omits dtype from the Embedder config when RAG_DTYPE is unset', () => {
      delete process.env['RAG_DTYPE']

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledOnce()
      const passedConfig = mocks.Embedder.mock.calls[0]?.[0]
      expect(passedConfig).not.toHaveProperty('dtype')
    })

    it('passes RAG_DTYPE through to the Embedder when set', () => {
      process.env['RAG_DTYPE'] = 'q8'

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      expect(mocks.Embedder).toHaveBeenCalledWith(expect.objectContaining({ dtype: 'q8' }))
    })

    it('omits dtype when RAG_DTYPE is whitespace-only', () => {
      process.env['RAG_DTYPE'] = '   '

      createEmbedder(makeConfig({ modelName: 'custom/model', cacheDir: '/custom/cache' }))

      const passedConfig = mocks.Embedder.mock.calls[0]?.[0]
      expect(passedConfig).not.toHaveProperty('dtype')
    })
  })
})
