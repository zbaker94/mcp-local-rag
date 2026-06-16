// Embedder error types.
//
// Colocated in a dedicated `errors.ts` leaf module — the same convention the
// parser package uses (`parser/errors.ts`) — so every package keeps its domain
// error classes in one predictable place rather than inline in `index.ts`.
// `index.ts` re-exports `EmbeddingError` so existing `../embedder/index.js`
// import sites keep working unchanged.

import { AppError } from '../utils/errors.js'

/**
 * Embedding generation error
 */
export class EmbeddingError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'embedder', 'internal', cause)
    this.name = 'EmbeddingError'
  }
}
