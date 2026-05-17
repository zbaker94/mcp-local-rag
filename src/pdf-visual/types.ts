// Shared types for the `pdf-visual` package.
//
// `VlmError` is the package-wide named error for the visual ingest path. It
// was originally staged in `renderer.ts` (T3.1) and promoted here at T3.3 so
// that `renderer.ts`, `captioner.ts`, and the orchestrator (`index.ts`) can
// all import from a single source. Shape mirrors
// `src/parser/index.ts:54-62`'s `ValidationError` pattern: a named class
// extending `Error`, with `name` assignment and a public override `cause`.
//
// `CaptionerConfig` / `Captioner` are the captioner's public interface,
// declared per DD § Component → pdf-visual/captioner.ts.

/**
 * Error raised by any module on the visual ingest path. Carries the offending
 * 1-based page number so callers can correlate it with the page list.
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
 * Captioner configuration. Model identifier and quantization variant are
 * pinned for v1; the only caller-tunable fields are the cache directory and
 * the optional execution device.
 */
export interface CaptionerConfig {
  /**
   * HuggingFace model identifier. Fixed by the caller in v1; the field is
   * retained so a future model-family adapter can flip it from a literal to a
   * resolver without changing this contract.
   */
  modelName: string
  /** Model cache directory (shared with the embedder via `env.cacheDir`). */
  cacheDir: string
  /** Execution device passed through to Transformers.js model loading. */
  device?: string | undefined
}

/**
 * Captioner public surface. Returns the caption string or `null` when the
 * model produced an empty result (after control-char stripping + whitespace
 * trim). A `null` return signals the orchestrator to skip this page without
 * raising — only model load / image decode / generation failures throw.
 */
export interface Captioner {
  caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null>
}
