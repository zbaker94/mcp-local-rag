// Supported ingest file extensions.
//
// A dependency-free utils leaf so the file-collection / scan helpers can gate on
// extensions without importing the `parser` domain barrel (which would invert
// the utils-as-leaf dependency direction). `parser/index.ts` re-exports this so
// existing `../parser/index.js` import sites keep working unchanged.

/** Lower-cased file extensions the ingest pipeline can parse. */
export const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md'])
