// `TextChunk` lives in `./types.js` (a dependency-free leaf) and is re-exported
// here so `../chunker/index.js` import sites keep working while
// `semantic-chunker.ts` references the type without importing from this barrel.

export { CodeChunker, type CodeChunkerConfig, codeLanguageForExtension } from './code-chunker.js'
export { selectChunker } from './select-chunker.js'
export { DEFAULT_MIN_CHUNK_LENGTH, SemanticChunker } from './semantic-chunker.js'
export type { Chunker, EmbedderInterface, TextChunk } from './types.js'
