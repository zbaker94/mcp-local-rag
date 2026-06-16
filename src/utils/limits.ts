// Cross-cutting numeric limits shared across CLI and MCP server entry points.
// Dependency-free leaf module so any layer can import it without coupling.

/**
 * Maximum directory recursion depth when scanning a base directory or ingest
 * target. Applied identically by the CLI `ingest`/`list` walkers and the MCP
 * server's `list_files` scan so the boundary is consistent everywhere.
 */
export const MAX_SCAN_DEPTH = 10

/**
 * Default maximum file size for ingestion, in bytes (100 MB). Used when neither
 * the CLI `--max-file-size` flag nor the `MAX_FILE_SIZE` env var is provided.
 */
export const DEFAULT_MAX_FILE_SIZE = 104_857_600

/**
 * Hard upper bound (inclusive) for the configurable max file size, in bytes
 * (500 MB). Values above this are rejected by `validateMaxFileSize`.
 */
export const MAX_FILE_SIZE_LIMIT = 524_288_000

/**
 * Maximum byte length of in-memory content accepted by the `ingest_data` MCP
 * tool (50 MB). Unlike `ingest_file`, `ingest_data` content never touches
 * `validateFileSize` (it is parsed/embedded straight from the request), so this
 * is the only bound protecting the HTML parser (JSDOM/Readability/Turndown) and
 * the embedder from an unbounded request body. Measured in UTF-8 bytes so the
 * limit reflects real memory cost, not JS code-unit count.
 */
export const MAX_INGEST_DATA_CONTENT_BYTES = 52_428_800

/**
 * Maximum number of pages processed from a single PDF. The on-disk
 * `validateFileSize` cap bounds the file's compressed bytes but NOT the work
 * the per-page extraction loop performs: a small PDF can declare an enormous
 * page count via compressed object/xref streams ("PDF bomb"), driving the
 * loop into multi-GB heap + unbounded CPU. Pages beyond this cap are rejected
 * with a `ValidationError` before any per-page work accumulates.
 */
export const MAX_PDF_PAGES = 5_000

/**
 * Maximum size (in UTF-16 code units of the structured-text JSON) accepted for
 * a single PDF page. Guards against a single page packed with millions of
 * glyph runs — which `MAX_PDF_PAGES` alone does not bound — expanding into a
 * giant in-memory JSON string + items array. ~32 MB of JSON text per page.
 */
export const MAX_PDF_PAGE_STEXT_CHARS = 33_554_432
