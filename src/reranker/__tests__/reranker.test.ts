// Reranker unit tests.
//
// The cross-encoder model is NOT loaded here: ms-marco isn't in the test cache,
// and mocking the shared @huggingface/transformers module risks cross-file mock
// leakage (vitest runs isolate:false). Instead the rerank LOGIC (batching,
// sigmoid, score inversion, sort) is exercised by injecting a fake tokenizer +
// model onto the instance, which makes `ensureInitialized` short-circuit
// (`this.model` truthy). A separate test covers the lazy-init-once contract.

import { basename } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../vectordb/types.js'
import { Reranker, type RerankerConfig } from '../index.js'

function mockResult(filePath: string, text: string, score = 0.5): SearchResult {
  return {
    filePath,
    chunkIndex: 0,
    text,
    score,
    metadata: { fileName: basename(filePath), fileSize: 100, fileType: '.txt' },
    fileTitle: null,
  }
}

const config: RerankerConfig = {
  modelPath: 'Xenova/ms-marco-MiniLM-L-6-v2',
  batchSize: 16,
  cacheDir: '/tmp/does-not-matter',
}

/** Inject a fake tokenizer + model that scores each doc by a text→logit map. */
function injectFakeModel(
  reranker: Reranker,
  logitByText: Record<string, number>,
  labels = 1
): void {
  // Fake tokenizer just forwards the doc texts for the fake model to read.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields for a hermetic logic test
  ;(reranker as any).tokenizer = (_queries: string[], opts: { text_pair: string[] }) => ({
    pairs: opts.text_pair,
  })
  // biome-ignore lint/suspicious/noExplicitAny: reaching into private fields for a hermetic logic test
  ;(reranker as any).model = async (inputs: { pairs: string[] }) => {
    const pairs = inputs.pairs
    const data = new Float32Array(pairs.length * labels)
    pairs.forEach((doc, i) => {
      // For multi-label, fill the last label (the one rerank reads) with the logit.
      data[i * labels + (labels - 1)] = logitByText[doc] ?? 0
    })
    return { logits: { data, dims: [pairs.length, labels] } }
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

describe('Reranker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns input unchanged and never initializes on empty results', async () => {
    const reranker = new Reranker(config)
    const initSpy = vi.spyOn(reranker, 'initialize')
    const out = await reranker.rerank('q', [])
    expect(out).toEqual([])
    expect(initSpy).not.toHaveBeenCalled()
  })

  it('sorts by descending relevance and inverts score to lower-is-better', async () => {
    const reranker = new Reranker(config)
    injectFakeModel(reranker, { 'doc-a': 2, 'doc-b': -1, 'doc-c': 0.5 })

    const results = [
      mockResult('/b.txt', 'doc-b'),
      mockResult('/a.txt', 'doc-a'),
      mockResult('/c.txt', 'doc-c'),
    ]
    const out = await reranker.rerank('query', results)

    // sigmoid(2) > sigmoid(0.5) > sigmoid(-1) → a, c, b
    expect(out.map((r) => r.filePath)).toEqual(['/a.txt', '/c.txt', '/b.txt'])
    expect(out[0]!.rerankerScore).toBeCloseTo(sigmoid(2))
    expect(out[0]!.score).toBeCloseTo(1 - sigmoid(2))
    // Output is ascending by score (lower = better).
    expect(out[0]!.score).toBeLessThan(out[1]!.score)
    expect(out[1]!.score).toBeLessThan(out[2]!.score)
  })

  it('scores across multiple batches', async () => {
    const reranker = new Reranker({ ...config, batchSize: 2 })
    injectFakeModel(reranker, { d0: 0.1, d1: 3, d2: -2, d3: 1 })

    const results = [
      mockResult('/0.txt', 'd0'),
      mockResult('/1.txt', 'd1'),
      mockResult('/2.txt', 'd2'),
      mockResult('/3.txt', 'd3'),
    ]
    const out = await reranker.rerank('query', results)

    // All four returned, ranked by logit desc: d1(3), d3(1), d0(0.1), d2(-2)
    expect(out).toHaveLength(4)
    expect(out.map((r) => r.filePath)).toEqual(['/1.txt', '/3.txt', '/0.txt', '/2.txt'])
  })

  it('reads the last logit for multi-label model output', async () => {
    const reranker = new Reranker(config)
    injectFakeModel(reranker, { hi: 4, lo: -4 }, 2)

    const out = await reranker.rerank('query', [
      mockResult('/lo.txt', 'lo'),
      mockResult('/hi.txt', 'hi'),
    ])
    expect(out[0]!.filePath).toBe('/hi.txt')
    expect(out[0]!.rerankerScore).toBeCloseTo(sigmoid(4))
  })

  it('wraps a model failure in RerankerError', async () => {
    const reranker = new Reranker(config)
    // biome-ignore lint/suspicious/noExplicitAny: hermetic failure injection
    ;(reranker as any).tokenizer = () => ({})
    // biome-ignore lint/suspicious/noExplicitAny: hermetic failure injection
    ;(reranker as any).model = async () => {
      throw new Error('boom')
    }
    await expect(reranker.rerank('q', [mockResult('/a.txt', 'a')])).rejects.toThrow(
      /Failed to rerank/
    )
  })

  it('initializes only once across concurrent rerank calls', async () => {
    const reranker = new Reranker(config)
    const initSpy = vi.spyOn(reranker, 'initialize').mockImplementation(async () => {
      injectFakeModel(reranker, { a: 1, b: 2 })
    })

    const calls = [
      reranker.rerank('q', [mockResult('/a.txt', 'a')]),
      reranker.rerank('q', [mockResult('/b.txt', 'b')]),
      reranker.rerank('q', [mockResult('/a.txt', 'a')]),
    ]
    await Promise.all(calls)
    expect(initSpy).toHaveBeenCalledTimes(1)
  })
})
