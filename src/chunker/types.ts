// Chunker shared types.
//
// `TextChunk` lives in this dependency-free leaf module so `semantic-chunker.ts`
// can reference it without importing from the `index.ts` barrel (which re-exports
// `semantic-chunker.ts`), removing the reported barrel ↔ module import cycle.
// `index.ts` re-exports `TextChunk` so existing `../chunker/index.js` import
// sites keep working unchanged.

/**
 * Text chunk
 */
export interface TextChunk {
  /** Chunk text */
  text: string
  /** Chunk index (zero-based) */
  index: number
}
