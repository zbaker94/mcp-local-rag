// Supported ingest file extensions.
//
// A dependency-free utils leaf so the file-collection / scan helpers can gate on
// extensions without importing the `parser` domain barrel (which would invert
// the utils-as-leaf dependency direction). `parser/index.ts` re-exports this so
// existing `../parser/index.js` import sites keep working unchanged.

/**
 * Lower-cased file extensions the ingest pipeline can parse. Code extensions
 * (ts/tsx/js/jsx/mjs/cjs/py) are read as raw text by the parser and chunked at
 * AST boundaries by the CodeChunker (see `selectChunker`).
 */
export const SUPPORTED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
])
