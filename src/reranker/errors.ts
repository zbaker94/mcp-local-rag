// Reranker error types.
//
// Colocated in a dedicated `errors.ts` leaf module — the same convention the
// embedder and parser packages use — so each package keeps its domain error
// classes in one predictable place. `index.ts` re-exports `RerankerError` so
// import sites can pull it from `../reranker/index.js`.

import { AppError } from '../utils/errors.js'

/**
 * Cross-encoder reranking error.
 */
export class RerankerError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'reranker', 'internal', cause)
    this.name = 'RerankerError'
  }
}
