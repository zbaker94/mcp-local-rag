// `TextChunk` lives in `./types.js` (a dependency-free leaf) and is re-exported
// here so `../chunker/index.js` import sites keep working while
// `semantic-chunker.ts` references the type without importing from this barrel.

export { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from './semantic-chunker.js'
export type { TextChunk } from './types.js'
