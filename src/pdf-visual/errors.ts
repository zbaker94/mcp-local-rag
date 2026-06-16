// pdf-visual error types.
//
// Colocated in a dedicated `errors.ts` leaf module — the same convention the
// parser package uses (`parser/errors.ts`) — so every package keeps its domain
// error classes in one predictable place rather than inline in `types.ts`.
// `types.ts` re-exports `VlmError` so existing `./types.js` import sites keep
// working unchanged.

import { AppError } from '../utils/errors.js'

/**
 * Error raised by any module on the visual ingest path. Carries the offending
 * 1-based page number so callers can correlate it with the page list. It joins
 * the shared `AppError` taxonomy (taxonomy only — name/message/cause behavior
 * is unchanged) and additionally carries the offending page number.
 */
export class VlmError extends AppError {
  public readonly pageNum: number

  constructor(message: string, options: { cause?: Error; pageNum: number }) {
    super(message, 'pdf-visual', 'internal', options.cause)
    this.name = 'VlmError'
    this.pageNum = options.pageNum
  }
}
