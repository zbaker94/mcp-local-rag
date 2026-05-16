// Embedder unit tests
// Test Type: Integration Test (uses the real @huggingface/transformers pipeline)
// Covers the wrapped-error paths and empty-input short-circuits that the
// maintainer flagged as untested.

import { describe, expect, it } from 'vitest'
import { Embedder, EmbeddingError } from '../../embedder/index.js'

function makeEmbedder(device?: string): Embedder {
  return new Embedder({
    modelPath: 'Xenova/all-MiniLM-L6-v2',
    batchSize: 16,
    cacheDir: './tmp/models',
    ...(device !== undefined ? { device } : {}),
  })
}

describe('Embedder', () => {
  describe('embed() input validation', () => {
    it('rejects empty string before initializing the model', async () => {
      // Use a deliberately broken device so init *would* fail if it were attempted.
      // The empty-text guard must short-circuit before we get there.
      const embedder = makeEmbedder('definitely-not-a-real-device')

      const err = await embedder.embed('').catch((e) => e as Error)
      expect(err).toBeInstanceOf(EmbeddingError)
      expect(err.message).toBe('Cannot generate embedding for empty text')
    })
  })

  describe('embedBatch()', () => {
    it('returns [] for empty input without initializing the model', async () => {
      const embedder = makeEmbedder('definitely-not-a-real-device')

      // No init attempt → no device error surfaces.
      await expect(embedder.embedBatch([])).resolves.toEqual([])
    })

    it('early-rethrows EmbeddingError from embed() instead of re-wrapping with batch guidance', async () => {
      const embedder = makeEmbedder('cpu')

      const err = await embedder.embedBatch(['valid', '']).catch((e) => e as Error)
      expect(err).toBeInstanceOf(EmbeddingError)
      expect(err.message).toBe('Cannot generate embedding for empty text')
      expect(err.message).not.toMatch(/Failed to generate batch embeddings/)
    })
  })

  describe('device validation', () => {
    it('surfaces transformers.js native error as EmbeddingError when pipeline init fails', async () => {
      const embedder = makeEmbedder('definitely-not-a-real-device')

      const err = await embedder.embed('hello').catch((e) => e as Error)
      expect(err).toBeInstanceOf(EmbeddingError)
      // Underlying message comes through verbatim; we don't add our own prefix.
      expect(err.message).toMatch(/Unsupported device/)
      expect(err.message).toMatch(/definitely-not-a-real-device/)
    })

    it('does not add speculative cache/network guidance to init failures', async () => {
      const embedder = makeEmbedder('definitely-not-a-real-device')

      const err = await embedder.embed('hello').catch((e) => e as Error)
      expect(err).toBeInstanceOf(EmbeddingError)
      expect(err.message).not.toMatch(/Network connectivity/)
      expect(err.message).not.toMatch(/Insufficient disk space/)
    })
  })

  describe('dispose()', () => {
    it('is safe to call before any embed() invocation', async () => {
      const embedder = makeEmbedder('cpu')
      await expect(embedder.dispose()).resolves.toBeUndefined()
    })
  })
})
