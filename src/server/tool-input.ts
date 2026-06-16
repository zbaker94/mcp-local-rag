// Runtime validation for MCP tool arguments.
//
// MCP tool arguments arrive as `unknown` from the SDK: TypeScript types are
// erased at runtime, so the previous `as unknown as XxxInput` casts let
// malformed input flow into the handlers (non-string query, negative limit,
// missing metadata, enum-violating format). These validators reject malformed
// input at the entry boundary with `McpError(InvalidParams)` — the same
// structured failure shape `read_chunk_neighbors` already uses — without
// leaking internal diagnostics to the client.

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { MAX_INGEST_DATA_CONTENT_BYTES } from '../utils/limits.js'
import { CONTENT_FORMATS, type ContentFormat } from '../utils/raw-data-utils.js'
import type {
  DeleteFileInput,
  IngestDataInput,
  IngestFileInput,
  QueryDocumentsInput,
  ReadChunkNeighborsInput,
} from './types.js'

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new McpError(ErrorCode.InvalidParams, `${label} arguments must be an object`)
  }
  return raw as Record<string, unknown>
}

/**
 * Assert an optional argument is a string when present. Returns the validated
 * string or `undefined` when the key is absent. Shared by the dual-input
 * (`filePath` / `source`) tool validators so a non-string path argument is
 * rejected with a structured `McpError(InvalidParams)` at the boundary instead
 * of being silently treated as "absent" downstream.
 */
function optionalString(
  obj: Record<string, unknown>,
  key: string,
  label: string
): string | undefined {
  const value = obj[key]
  if (value !== undefined && typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `${label} must be a string if provided`)
  }
  return value
}

/**
 * Validate `query_documents` arguments. `query` must be a non-empty string;
 * `limit`, when provided, must be a positive integer (the handler defaults it
 * to 10 when absent).
 */
export function parseQueryDocumentsInput(raw: unknown): QueryDocumentsInput {
  const obj = asRecord(raw, 'query_documents')
  const { query, limit } = obj

  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'query must be a non-empty string')
  }

  if (limit !== undefined) {
    // Bound to 1-20 at the entry boundary — the same range VectorStore.search
    // enforces and the CLI `--limit` accepts. Rejecting here returns a clean
    // McpError(InvalidParams) instead of letting an out-of-range value reach
    // search() and surface as a DatabaseError.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new McpError(ErrorCode.InvalidParams, 'limit must be an integer between 1 and 20')
    }
    return { query, limit }
  }

  return { query }
}

/**
 * Validate `ingest_data` arguments. `content` must be a non-empty string;
 * `metadata` must be an object with a non-empty `source` string and a `format`
 * in the supported set.
 */
export function parseIngestDataInput(raw: unknown): IngestDataInput {
  const obj = asRecord(raw, 'ingest_data')
  const { content, metadata } = obj

  if (typeof content !== 'string' || content.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'content must be a non-empty string')
  }

  // Bound the request body BEFORE any HTML parsing / embedding. ingest_data
  // content bypasses validateFileSize (it is never read from disk first), so
  // this is the only guard preventing an oversized payload from exhausting
  // memory/CPU in JSDOM or the embedder. Measured in UTF-8 bytes.
  const contentBytes = Buffer.byteLength(content, 'utf-8')
  if (contentBytes > MAX_INGEST_DATA_CONTENT_BYTES) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `content exceeds maximum size: ${contentBytes} bytes > ${MAX_INGEST_DATA_CONTENT_BYTES} bytes (50MB)`
    )
  }

  const meta = asRecord(metadata, 'ingest_data metadata')
  const { source, format } = meta

  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'metadata.source must be a non-empty string')
  }

  if (typeof format !== 'string' || !CONTENT_FORMATS.includes(format as ContentFormat)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `metadata.format must be one of: ${CONTENT_FORMATS.join(', ')}`
    )
  }

  return { content, metadata: { source, format: format as ContentFormat } }
}

/**
 * Validate `ingest_file` arguments. `filePath` must be a non-empty string — the
 * trust-boundary guard the cast-based dispatch previously omitted. `visual` and
 * `visualQuality` are forwarded verbatim because `handleIngestFile` (also
 * reachable via the internal `handleIngestData` path) owns their runtime
 * validation and normalization; re-checking them here would split that policy.
 */
export function parseIngestFileInput(raw: unknown): IngestFileInput {
  const obj = asRecord(raw, 'ingest_file')
  const { filePath } = obj

  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, 'filePath must be a non-empty string')
  }

  const result: IngestFileInput = { filePath }
  // Cast the raw values through the declared (non-undefined) field types: the
  // guard above proves presence, and handleIngestFile re-checks the actual
  // runtime shape, rejecting a non-boolean `visual` / out-of-enum quality.
  if (obj['visual'] !== undefined) {
    result.visual = obj['visual'] as boolean
  }
  if (obj['visualQuality'] !== undefined) {
    result.visualQuality = obj['visualQuality'] as 'fast' | 'quality' | ''
  }
  return result
}

/**
 * Validate `delete_file` arguments. `filePath` and `source` must each be a
 * string when present; the "exactly one must be provided" rule and config
 * gating stay in `handleDeleteFile` (which is also called directly), so this
 * validator only enforces the boundary type shape.
 */
export function parseDeleteFileInput(raw: unknown): DeleteFileInput {
  const obj = asRecord(raw, 'delete_file')
  const result: DeleteFileInput = {}

  const filePath = optionalString(obj, 'filePath', 'filePath')
  if (filePath !== undefined) {
    result.filePath = filePath
  }
  const source = optionalString(obj, 'source', 'source')
  if (source !== undefined) {
    result.source = source
  }
  return result
}

/**
 * Validate `read_chunk_neighbors` arguments. `filePath`/`source` are guarded as
 * strings at the boundary; the numeric `chunkIndex`/`before`/`after` range
 * checks and the filePath/source XOR stay in `handleReadChunkNeighbors`, so
 * those fields are forwarded for the handler to validate.
 */
export function parseReadChunkNeighborsInput(raw: unknown): ReadChunkNeighborsInput {
  const obj = asRecord(raw, 'read_chunk_neighbors')
  // `chunkIndex` is required by the type but range-validated by the handler;
  // forward it (and the optional numeric fields) for that single check.
  const result: ReadChunkNeighborsInput = { chunkIndex: obj['chunkIndex'] as number }

  const filePath = optionalString(obj, 'filePath', 'filePath')
  if (filePath !== undefined) {
    result.filePath = filePath
  }
  const source = optionalString(obj, 'source', 'source')
  if (source !== undefined) {
    result.source = source
  }
  if (obj['before'] !== undefined) {
    result.before = obj['before'] as number
  }
  if (obj['after'] !== undefined) {
    result.after = obj['after'] as number
  }
  return result
}
