// Vectordb error types.
//
// Colocated in a dedicated `errors.ts` leaf module — the same convention the
// parser package uses (`parser/errors.ts`) — so every package keeps its domain
// error classes in one predictable place rather than inline in `types.ts`.
// `types.ts` re-exports `DatabaseError` so existing `../vectordb/types.js`
// import sites keep working unchanged.

import { AppError } from '../utils/errors.js'

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'vectordb', 'internal', cause)
    this.name = 'DatabaseError'
  }
}
