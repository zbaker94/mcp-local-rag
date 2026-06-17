// Cross-encoder reranker using Transformers.js.
//
// Opt-in second-stage ranker: after hybrid (RRF) search produces a candidate
// pool, the reranker scores each query+document pair with a cross-encoder and
// re-sorts by relevance. Disabled by default (see RAG_RERANK) — when off, this
// module is never constructed and its ~80MB model is never loaded.

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  type DataType,
  type DeviceType,
  env,
} from '@huggingface/transformers'
import type { SearchResult } from '../vectordb/types.js'
import { RerankerError } from './errors.js'

export { RerankerError }

/** Default cross-encoder model (MS MARCO MiniLM, single relevance logit). */
export const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'

/**
 * Candidate pool size requested from vector search when reranking is enabled.
 * The reranker re-sorts these, then the handler slices to the user's `limit`.
 */
export const RERANK_CANDIDATES = 30

/**
 * Reranker configuration. Mirrors {@link EmbedderConfig} so it can be resolved
 * from the same device/dtype/cacheDir plumbing.
 */
export interface RerankerConfig {
  /** HuggingFace model path */
  modelPath: string
  /** Batch size for pair scoring */
  batchSize: number
  /** Model cache directory */
  cacheDir: string
  /** Device type (cpu, webgpu, ...) */
  device?: string
  /** Quantization dtype; unset → fp32 */
  dtype?: string
  /** When false, transformers.js runs offline (local cache only) */
  allowRemoteModels?: boolean
}

interface TokenizerOutput {
  [key: string]: unknown
}
type TokenizerFn = (text: string[], options: unknown) => TokenizerOutput
type ModelFn = (
  inputs: TokenizerOutput
) => Promise<{ logits: { data: Float32Array; dims: number[] } }>

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Cross-encoder reranker. Lazy-initializes the tokenizer + sequence-
 * classification model on first {@link rerank} call (mirroring the Embedder's
 * lifecycle), so an enabled-but-unused server pays no model-load cost.
 */
export class Reranker {
  // `unknown` to avoid TS2590 (the transformers.js model union is huge).
  private model: unknown = null
  private tokenizer: unknown = null
  private initPromise: Promise<void> | null = null
  private readonly config: RerankerConfig

  constructor(config: RerankerConfig) {
    this.config = config
  }

  /** Release the model pipeline. */
  async dispose(): Promise<void> {
    const model = this.model as { dispose?: () => Promise<void> } | null
    if (model && typeof model.dispose === 'function') {
      try {
        await model.dispose()
      } catch (error) {
        console.error('Error disposing reranker model:', error)
      }
    }
    this.model = null
    this.tokenizer = null
    this.initPromise = null
  }

  /** Load tokenizer + model. Throws RerankerError on failure. */
  async initialize(): Promise<void> {
    if (this.model) {
      return
    }

    env.cacheDir = this.config.cacheDir
    if (this.config.allowRemoteModels === false) {
      env.allowRemoteModels = false
      env.allowLocalModels = true
    }

    const device = this.config.device || 'cpu'
    console.error(`Reranker: Loading model "${this.config.modelPath}" on device "${device}"...`)

    try {
      this.tokenizer = await AutoTokenizer.from_pretrained(this.config.modelPath)
      this.model = await AutoModelForSequenceClassification.from_pretrained(this.config.modelPath, {
        dtype: (this.config.dtype ?? 'fp32') as DataType,
        device: device as DeviceType,
      })
      console.error(`Reranker: Model loaded successfully (device=${device})`)
    } catch (error) {
      const nativeError = error as Error
      throw new RerankerError(
        `Failed to load reranker model "${this.config.modelPath}": ${nativeError.message}`,
        nativeError
      )
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.model) {
      return
    }
    if (this.initPromise) {
      await this.initPromise
      return
    }
    console.error('Reranker: First use detected. Initializing cross-encoder model...')
    this.initPromise = this.initialize().catch((error) => {
      this.initPromise = null
      throw error
    })
    await this.initPromise
  }

  /**
   * Re-score `results` against `query` with the cross-encoder and return them
   * sorted by descending relevance.
   *
   * Each result's `rerankerScore` is set to the model's relevance in (0,1)
   * (sigmoid of the regression logit). To preserve the codebase's lower-is-
   * better `score` convention, `score` is overwritten with `1 - relevance`.
   * Long chunks are truncated to the model's max length by the tokenizer.
   *
   * Returns the input unchanged (no model load) when `results` is empty.
   */
  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (results.length === 0) {
      return results
    }

    await this.ensureInitialized()

    try {
      const tokenizer = this.tokenizer as TokenizerFn
      const model = this.model as ModelFn

      const scored: { result: SearchResult; relevance: number }[] = []
      for (let i = 0; i < results.length; i += this.config.batchSize) {
        const batch = results.slice(i, i + this.config.batchSize)
        const queries = batch.map(() => query)
        const docs = batch.map((r) => r.text)

        const inputs = tokenizer(queries, { text_pair: docs, padding: true, truncation: true })
        const output = await model(inputs)

        const { data, dims } = output.logits
        // Cross-encoders emit one regression logit per pair (dims [batch, 1]).
        // If a model emits multiple labels, take the last logit (the positive/
        // relevant class by convention). Either way, sigmoid → relevance (0,1).
        const labels = dims[dims.length - 1] ?? 1
        for (let row = 0; row < batch.length; row++) {
          const logit = data[row * labels + (labels - 1)] ?? 0
          const item = batch[row]
          if (item !== undefined) {
            scored.push({ result: item, relevance: sigmoid(logit) })
          }
        }
      }

      return scored
        .sort((a, b) => b.relevance - a.relevance)
        .map(({ result, relevance }) => ({
          ...result,
          score: 1 - relevance,
          rerankerScore: relevance,
        }))
    } catch (error) {
      if (error instanceof RerankerError) {
        throw error
      }
      throw new RerankerError(
        `Failed to rerank results: ${(error as Error).message}`,
        error as Error
      )
    }
  }
}
