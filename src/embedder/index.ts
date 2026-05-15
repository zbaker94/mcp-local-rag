// Embedder implementation with Transformers.js

import { type DeviceType, env, pipeline } from '@huggingface/transformers'

const VALID_DEVICES: readonly DeviceType[] = [
  'auto',
  'gpu',
  'cpu',
  'wasm',
  'webgpu',
  'cuda',
  'dml',
  'coreml',
  'webnn',
  'webnn-npu',
  'webnn-gpu',
  'webnn-cpu',
] as const

function resolveDevice(): DeviceType {
  const raw = process.env['RAG_DEVICE']?.trim()
  if (!raw) return 'cpu'
  if ((VALID_DEVICES as readonly string[]).includes(raw)) return raw as DeviceType
  throw new Error(`RAG_DEVICE="${raw}" is not a valid device. Valid: ${VALID_DEVICES.join(', ')}`)
}

// ============================================
// Type Definitions
// ============================================

/**
 * Embedder configuration
 */
export interface EmbedderConfig {
  /** HuggingFace model path */
  modelPath: string
  /** Batch size */
  batchSize: number
  /** Model cache directory */
  cacheDir: string
}

// ============================================
// Error Classes
// ============================================

/**
 * Embedding generation error
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public override readonly cause?: Error
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

// ============================================
// Embedder Class
// ============================================

/**
 * Embedding generation class using Transformers.js
 *
 * Responsibilities:
 * - Generate embedding vectors (dimension depends on model)
 * - Transformers.js wrapper
 * - Batch processing (size 8)
 */
export class Embedder {
  // Using unknown to avoid TS2590 (union type too complex with @types/jsdom)
  private model: unknown = null
  private initPromise: Promise<void> | null = null
  private readonly config: EmbedderConfig

  constructor(config: EmbedderConfig) {
    this.config = config
  }

  /**
   * Initialize Transformers.js model
   */
  async initialize(): Promise<void> {
    // Skip if already initialized
    if (this.model) {
      return
    }

    // Set cache directory BEFORE creating pipeline
    env.cacheDir = this.config.cacheDir

    // RAG_DEVICE selects the execution provider. Default 'cpu' is safe everywhere.
    // The user picks from the transformers.js device list (cpu, webgpu, dml, cuda,
    // coreml, wasm, auto, gpu, etc.) — we validate the string and pass it through.
    // No fallback — if the requested device fails, init throws.
    const device = resolveDevice()

    console.error(`Embedder: Setting cache directory to "${this.config.cacheDir}"`)
    console.error(`Embedder: Loading model "${this.config.modelPath}" on device "${device}"...`)

    try {
      this.model = await pipeline('feature-extraction', this.config.modelPath, {
        dtype: 'fp32',
        device,
      })
      console.error(`Embedder: Model loaded successfully (device=${device})`)
    } catch (error) {
      throw new EmbeddingError(
        `Failed to initialize Embedder on device "${device}": ${(error as Error).message}\n\n` +
          'Set RAG_DEVICE=cpu to force CPU. Other values: gpu (auto per platform), dml, cuda, coreml, webgpu, wasm, auto.',
        error as Error
      )
    }
  }

  /**
   * Ensure model is initialized (lazy initialization)
   * This method is called automatically by embed() and embedBatch()
   */
  private async ensureInitialized(): Promise<void> {
    // Already initialized
    if (this.model) {
      return
    }

    // Initialization already in progress, wait for it
    if (this.initPromise) {
      await this.initPromise
      return
    }

    // Start initialization
    console.error(
      'Embedder: First use detected. Initializing model (downloading ~90MB, may take 1-2 minutes)...'
    )

    this.initPromise = this.initialize().catch((error) => {
      // Clear initPromise on failure to allow retry
      this.initPromise = null

      // Enhance error message with detailed guidance
      throw new EmbeddingError(
        `Failed to initialize embedder on first use: ${(error as Error).message}\n\nPossible causes:\n  • Network connectivity issues during model download\n  • Insufficient disk space (need ~90MB)\n  • Corrupted model cache\n\nRecommended actions:\n  1. Check your internet connection and try again\n  2. Ensure sufficient disk space is available\n  3. If problem persists, delete cache: ${this.config.cacheDir}\n  4. Then retry your query\n`,
        error as Error
      )
    })

    await this.initPromise
  }

  /**
   * Convert single text to embedding vector
   *
   * @param text - Text
   * @returns Embedding vector (dimension depends on model)
   */
  async embed(text: string): Promise<number[]> {
    // Lazy initialization: initialize on first use if not already initialized
    await this.ensureInitialized()

    try {
      // Fail-fast for empty string: cannot generate meaningful embedding
      if (text.length === 0) {
        throw new EmbeddingError('Cannot generate embedding for empty text')
      }

      // Use type assertion to avoid complex Transformers.js type definitions
      // This is due to external library type definition constraints, runtime behavior is guaranteed
      const options = { pooling: 'mean', normalize: true }
      const modelCall = this.model as (
        text: string,
        options: unknown
      ) => Promise<{ data: Float32Array }>
      const output = await modelCall(text, options)

      // Access raw data via .data property
      const embedding = Array.from(output.data)
      return embedding
    } catch (error) {
      if (error instanceof EmbeddingError) {
        throw error
      }
      throw new EmbeddingError(
        `Failed to generate embedding: ${(error as Error).message}`,
        error as Error
      )
    }
  }

  /**
   * Convert multiple texts to embedding vectors with batch processing
   *
   * @param texts - Array of texts
   * @returns Array of embedding vectors (dimension depends on model)
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Lazy initialization: initialize on first use if not already initialized
    await this.ensureInitialized()

    if (texts.length === 0) {
      return []
    }

    try {
      const embeddings: number[][] = []

      // Process in batches according to batch size
      for (let i = 0; i < texts.length; i += this.config.batchSize) {
        const batch = texts.slice(i, i + this.config.batchSize)
        const batchEmbeddings = await Promise.all(batch.map((text) => this.embed(text)))
        embeddings.push(...batchEmbeddings)
      }

      return embeddings
    } catch (error) {
      throw new EmbeddingError(
        `Failed to generate batch embeddings: ${(error as Error).message}`,
        error as Error
      )
    }
  }
}
