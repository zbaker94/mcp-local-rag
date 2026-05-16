// PDF page renderer for the visual ingest path.
//
// Given an already-open mupdf `Document` and a 1-based page number, renders
// the page to a PNG byte array at the renderer-internal DPI. The renderer does
// NOT own the document lifecycle — the caller (orchestrator) opens and
// destroys the document; see DD §pdf-visual/renderer.ts and §AC-013.
//
// Contract (DD §Component → renderer.ts):
//   1. `page = doc.loadPage(pageNum - 1)`              (1-based → 0-based)
//   2. `matrix = [RENDER_DPI/72, 0, 0, RENDER_DPI/72, 0, 0]`
//   3. `pixmap = page.toPixmap(matrix, ColorSpace.DeviceRGB, false, true)`
//   4. return `pixmap.asPNG()`                          (Uint8Array, not Buffer)
//   5. on mupdf error → throw `VlmError('Failed to render PDF page',
//                                       { cause: err, pageNum })`
//
// `VlmError` is staged here for T3.1; T3.3 promotes it into
// `src/pdf-visual/types.ts`. Until then, downstream code that needs the type
// imports it from this module.

import type { Document as MupdfDocument } from 'mupdf'
import * as mupdf from 'mupdf'

// Module-private. Single consumer (this file). Not exported, not surfaced.
const RENDER_DPI = 150

/**
 * Error raised by the pdf-visual path. Carries the offending 1-based page
 * number so callers can correlate it with the page list. Promoted to
 * `src/pdf-visual/types.ts` by T3.3.
 */
export class VlmError extends Error {
  public override readonly cause?: Error
  public readonly pageNum: number

  constructor(message: string, options: { cause?: Error; pageNum: number }) {
    super(message)
    this.name = 'VlmError'
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
    this.pageNum = options.pageNum
  }
}

/**
 * Render a single PDF page to a PNG byte array.
 *
 * @param doc - An already-open mupdf `Document`. The renderer does NOT own the
 *              document lifecycle.
 * @param pageNum - 1-based page index. Translated to 0-based for mupdf.
 * @returns PNG bytes (`Uint8Array`, NOT `Buffer`).
 * @throws {VlmError} When mupdf rejects the page (out-of-range, render
 *                    failure, etc.). `cause` carries the original mupdf error;
 *                    `pageNum` carries the requested 1-based page.
 */
export async function renderPdfPage(doc: MupdfDocument, pageNum: number): Promise<Uint8Array> {
  try {
    const page = doc.loadPage(pageNum - 1)
    const matrix: mupdf.Matrix = [RENDER_DPI / 72, 0, 0, RENDER_DPI / 72, 0, 0]
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
    return pixmap.asPNG()
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    throw new VlmError('Failed to render PDF page', { cause, pageNum })
  }
}
