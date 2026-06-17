// Handler wiring tests for the opt-in reranker. These verify the integration
// path in handleQueryDocuments — that rerank ON pulls a larger candidate pool
// and routes results through reranker.rerank, while rerank OFF does neither —
// without loading any model (embedder/search/reranker are spied).

import { mkdir, rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RERANK_CANDIDATES } from '../../reranker/index.js'
import { RAGServer } from '../../server/index.js'
import type { SearchResult } from '../../vectordb/types.js'
import { withTestDevice } from '../test-device.js'

const testDbPath = './tmp/test-rerank-db'
const baseConfig = {
  dbPath: testDbPath,
  modelName: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: './tmp/test-model-cache',
  baseDirs: ['.'],
  maxFileSize: 10 * 1024 * 1024,
}

function fakeResult(filePath: string, score: number): SearchResult {
  return {
    filePath,
    chunkIndex: 0,
    text: `text-${filePath}`,
    score,
    metadata: { fileName: filePath, fileSize: 1, fileType: '.txt' },
    fileTitle: null,
  }
}

describe('reranker handler wiring', () => {
  beforeAll(async () => {
    await mkdir(testDbPath, { recursive: true })
  })
  afterAll(async () => {
    await rm(testDbPath, { recursive: true, force: true })
  })

  it('does not construct a reranker and uses the plain search path when rerank is off', async () => {
    const server = new RAGServer(withTestDevice(baseConfig))
    await server.initialize()

    // biome-ignore lint/suspicious/noExplicitAny: asserting on a private field
    expect((server as any).reranker).toBeNull()

    // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
    vi.spyOn((server as any).embedder, 'embed').mockResolvedValue([0.1, 0.2, 0.3])
    // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
    const searchSpy = vi
      // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
      .spyOn((server as any).vectorStore, 'search')
      .mockResolvedValue([fakeResult('/a.txt', 0.1)])

    await server.handleQueryDocuments({ query: 'hello', limit: 5 })

    // Called with no candidateCount (plain top-`limit` path).
    expect(searchSpy).toHaveBeenCalledWith([0.1, 0.2, 0.3], 'hello', 5)
  })

  it('pulls RERANK_CANDIDATES and routes through reranker.rerank when rerank is on', async () => {
    const server = new RAGServer(withTestDevice({ ...baseConfig, rerank: true }))
    await server.initialize()

    // biome-ignore lint/suspicious/noExplicitAny: asserting on a private field
    expect((server as any).reranker).not.toBeNull()

    const candidates = [fakeResult('/a.txt', 0.3), fakeResult('/b.txt', 0.1)]
    // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
    vi.spyOn((server as any).embedder, 'embed').mockResolvedValue([0.9])
    // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
    const searchSpy = vi.spyOn((server as any).vectorStore, 'search').mockResolvedValue(candidates)
    // Reranker reverses order — never loads a model.
    // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
    const rerankSpy = vi
      // biome-ignore lint/suspicious/noExplicitAny: spying private collaborators
      .spyOn((server as any).reranker, 'rerank')
      .mockImplementation(async (_q: string, results: SearchResult[]) => [...results].reverse())

    const out = await server.handleQueryDocuments({ query: 'hello', limit: 5 })

    // search asked for the larger candidate pool.
    expect(searchSpy).toHaveBeenCalledWith([0.9], 'hello', 5, RERANK_CANDIDATES)
    expect(rerankSpy).toHaveBeenCalledOnce()
    // Output reflects the reranked (reversed) order.
    const parsed = JSON.parse(out.content[0]!.text as string)
    expect(parsed[0].filePath).toBe('/b.txt')
  })
})
