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

/**
 * Minimal embedder contract a chunker may need. The semantic chunker uses
 * `embedBatch` to measure sentence similarity; the code chunker ignores it
 * (AST boundaries are deterministic) but keeps the parameter for interface
 * parity. Defined here (the dependency-free leaf) so both `Chunker` and the
 * concrete chunkers can reference it without a barrel import cycle.
 */
export interface EmbedderInterface {
  embedBatch(texts: string[]): Promise<number[][]>
}

/**
 * A chunker turns already-extracted document text into ordered {@link TextChunk}s.
 * Implementations: SemanticChunker (sentence similarity) and CodeChunker (AST
 * boundaries). The ingest path selects one per file via `selectChunker`.
 */
export interface Chunker {
  chunkText(text: string, embedder: EmbedderInterface): Promise<TextChunk[]>
}
