// Thin VLM wrapper for the visual ingest path.
//
// Wraps `@huggingface/transformers` direct model instantiation
// (`AutoProcessor.from_pretrained` + `AutoModelForImageTextToText.from_pretrained`)
// behind a small `Captioner` interface. Lazy-loads the processor and model
// on the first `caption()` call to keep the default (`visual: false`) path
// zero-overhead.
//
// Implementation contract:
//   1. Set `env.cacheDir = config.cacheDir` BEFORE any `from_pretrained` call
//      (defensive ordering — does not depend on `Embedder.initialize()`).
//   2. Lazy-load processor + model on first `caption()` call with the pinned
//      `VLM_DTYPE` and the resolved device.
//   3. Decode PNG bytes via `RawImage.fromBlob(new Blob([pngBytes], { type: 'image/png' }))`.
//   4. Build chat-style input via `processor.apply_chat_template(messages,
//      { add_generation_prompt: true })` with the IDEFICS3 conversation shape
//      (probe-verified). The shape is hard-coded against the v1 captioner
//      family; swapping in a non-IDEFICS3 model requires an adapter.
//   5. Call `model.generate({ ...inputs, max_new_tokens, repetition_penalty,
//      no_repeat_ngram_size })` with the pinned decoding options below.
//   6. Decode via `processor.batch_decode(newTokens, { skip_special_tokens: true })`
//      where `newTokens = outputs.slice(null, [inputs.input_ids.dims[1], null])`.
//   7. Post-processing (single source of truth, in this order):
//        - Strip C0 / C1 control chars except `\n` and `\t`.
//        - Trim surrounding whitespace.
//        - Empty → return `null`.
//        - length > 1000 → truncate to 1000 + `…` (final length 1001).
//   8. On model load / image decode / generation failure throw `VlmError`
//      with `pageNum` + `cause`. The empty-caption `null` return is NOT a
//      failure.
//
// `VLM_DTYPE = 'q4'` pins the ONNX quantization variant for v1. Exported so
// tests can assert against the literal without re-declaring it; production has
// no user-facing knob.

import {
  AutoModelForImageTextToText,
  AutoProcessor,
  type DeviceType,
  env,
  RawImage,
} from '@huggingface/transformers'

import type { Captioner, CaptionerConfig } from './types.js'
import { VlmError } from './types.js'

/**
 * ONNX quantization variant. Pinned to the smallest viable variant for the v1
 * captioner. Exposed for tests only — production has no user-facing knob.
 */
export const VLM_DTYPE = 'q4'

/**
 * Static prompt — tuned for "describe for search retrieval" not "describe for
 * a blind reader". It asks for retrieval-relevant detail rather than a short
 * summary, while keeping claims grounded in visible evidence.
 */
const PROMPT =
  'Write search text for this PDF page image. Include visible section names, visual titles, ' +
  'headings, labels, legends, axes, row or column names, UI text, metric names, identifiers, ' +
  'proper nouns, and flow or diagram step names. Prefer exact readable words from the image. ' +
  'Cover the main visual regions across the page. Use short searchable phrases separated by ' +
  'commas or semicolons. Use only readable or visually evident details. Use each phrase once.'

/**
 * Strip C0 (U+0000–U+001F) and C1 (U+007F–U+009F) control characters from the
 * input, except `\n` (U+000A) and `\t` (U+0009) which are kept verbatim.
 */
function stripControlChars(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code === 0x09 || code === 0x0a) {
      out += input[i]
      continue
    }
    if (code <= 0x1f) continue
    if (code >= 0x7f && code <= 0x9f) continue
    out += input[i]
  }
  return out
}

/**
 * Apply the post-generation processing rules (DD § Captioner contract step 6).
 * Returns the final caption or `null` when the result is empty after stripping.
 */
function postProcess(decoded: string): string | null {
  const stripped = stripControlChars(decoded).trim()
  if (stripped.length === 0) return null
  if (stripped.length > 1000) return `${stripped.slice(0, 1000)}…`
  return stripped
}

/**
 * Create a captioner backed by the configured VLM. Sets `env.cacheDir`
 * immediately so the global is correct even if the captioner is constructed
 * before any embedder initializes.
 *
 * Concurrency assumption: `env.cacheDir` is a process-global from
 * `@huggingface/transformers`. Setting it here at construction time is safe
 * for the current single-instance usage (one captioner per ingest run). If
 * the codebase ever constructs multiple captioners with DIFFERENT
 * `cacheDir` values in parallel, the last writer wins and the first
 * captioner's `from_pretrained` may resolve against the wrong cache. Avoid
 * concurrent construction with differing cacheDirs.
 */
export function createCaptioner(config: CaptionerConfig): Captioner {
  // Defensive ordering: set the global cacheDir at construction so the very
  // first `from_pretrained` call sees the right value. Setting the same
  // global twice with the same value is idempotent (shared with the
  // embedder).
  env.cacheDir = config.cacheDir

  const resolvedDevice = config.device || 'cpu'

  // Lazy-loaded singletons. `unknown` is used to keep the surface small and
  // avoid pulling private types from `@huggingface/transformers`.
  let processor: unknown = null
  let model: unknown = null

  // Cache the load outcome so a transient failure (network, mis-cached model
  // file) does not trigger one `from_pretrained` retry per candidate page.
  // Per-page `caption()` is the single wrapping site that adds `pageNum` and
  // the user-facing `Captioning failed for page N` message, so this fast-fail
  // path produces observationally-equivalent errors to a hypothetical
  // re-load attempt.
  type LoadState = { kind: 'pending' } | { kind: 'ok' } | { kind: 'failed'; cause: Error }
  let loadState: LoadState = { kind: 'pending' }

  async function ensureLoaded(): Promise<void> {
    if (loadState.kind === 'ok') return
    if (loadState.kind === 'failed') throw loadState.cause
    try {
      // Both classes accept `{ dtype }` (probe-verified). They load in sequence
      // because the second resolves the runtime class
      // (`Idefics3ForConditionalGeneration` for the default model) via the
      // architecture-agnostic `AutoModelForImageTextToText` entry point. The
      // transformers.js declared `dtype` is a literal union; cast through
      // `unknown` to widen-to-string-then-back.
      const dtypeOpt = { dtype: VLM_DTYPE } as unknown as { dtype: 'q4' }
      const modelOpt = { dtype: VLM_DTYPE, device: resolvedDevice } as unknown as {
        dtype: 'q4'
        device: DeviceType
      }
      processor = await AutoProcessor.from_pretrained(config.modelName, dtypeOpt)
      model = await AutoModelForImageTextToText.from_pretrained(config.modelName, modelOpt)
      loadState = { kind: 'ok' }
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err))
      const wrapped = new Error(
        `Captioner load failed (modelName=${config.modelName}, device=${resolvedDevice}): ${original.message}`,
        { cause: original }
      )
      loadState = { kind: 'failed', cause: wrapped }
      throw wrapped
    }
  }

  return {
    async caption(pngBytes: Uint8Array, pageNum: number): Promise<string | null> {
      try {
        await ensureLoaded()

        // Decode PNG → RawImage. `Blob` accepts `Uint8Array` directly (the
        // renderer returns `Uint8Array` from `Pixmap.asPNG()`, not `Buffer`).
        // The `BlobPart` type does not include `Uint8Array<ArrayBufferLike>`
        // due to SharedArrayBuffer subtyping; cast through unknown.
        const blob = new Blob([pngBytes as unknown as ArrayBuffer], { type: 'image/png' })
        const rawImage = await RawImage.fromBlob(blob)

        // Build chat-style input. The IDEFICS3 conversation shape is
        // probe-verified for `Idefics3Processor.apply_chat_template`.
        const messages = [
          {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: PROMPT }],
          },
        ]
        // The processor and model are dynamic in type at the boundary;
        // narrow to a minimal callable / generate-able shape here.
        const proc = processor as {
          apply_chat_template: (m: unknown, o: { add_generation_prompt: boolean }) => string
          batch_decode: (t: unknown, o: { skip_special_tokens: boolean }) => string[]
        } & ((prompt: string, images: unknown[]) => Promise<{ input_ids: { dims: number[] } }>)
        const mdl = model as {
          generate: (inputs: unknown) => Promise<{
            slice: (axis: null, range: [number, number | null]) => unknown
          }>
        }

        const chatPrompt = proc.apply_chat_template(messages, { add_generation_prompt: true })
        const inputs = await proc(chatPrompt, [rawImage])

        const outputs = await mdl.generate({
          ...inputs,
          max_new_tokens: 128,
          repetition_penalty: 1.15,
          no_repeat_ngram_size: 3,
        })

        // `outputs.slice(null, [inputLen, null])` strips the prompt tokens.
        const inputLen = inputs.input_ids.dims[1] as number
        const newTokens = outputs.slice(null, [inputLen, null])

        const decoded = proc.batch_decode(newTokens, { skip_special_tokens: true })
        const text = decoded[0] ?? ''

        return postProcess(text)
      } catch (err) {
        if (err instanceof VlmError) throw err
        const cause = err instanceof Error ? err : new Error(String(err))
        throw new VlmError(`Captioning failed for page ${pageNum}`, { cause, pageNum })
      }
    },
  }
}
