// VectorDB type definitions, constants, type guards, and error classes

import { DatabaseError } from './errors.js'

// ============================================
// Constants
// ============================================

/** FTS index name (bump version when changing tokenizer settings) */
export const FTS_INDEX_NAME = 'fts_index_v3'

/** Threshold for cleaning up old index versions (1 minute) */
export const FTS_CLEANUP_THRESHOLD_MS = 60 * 1000

/**
 * Default hybrid-search weight (vector vs FTS blend) when not configured.
 * In RRF this is the fusion blend: `weight` on the vector ranking and
 * `1 - weight` on the FTS ranking (0.6 = vector-favoring).
 */
export const DEFAULT_HYBRID_WEIGHT = 0.6

/**
 * RRF rank constant (`k`). Dampens the contribution of low-ranked items:
 * `contribution = weight / (k + rank)`. 60 is the value from the original
 * Cormack et al. RRF paper and the common default.
 */
export const RRF_K = 60

/**
 * Candidate pool size fetched from EACH ranked list (vector and FTS) before
 * fusion, so keyword-only hits have room to rank in. The effective pool is
 * `max(limit * 4, RRF_CANDIDATES)`.
 */
export const RRF_CANDIDATES = 30

// ============================================
// Type Definitions
// ============================================

/**
 * Grouping mode for quality filtering
 * - 'similar': Only return the most similar group (stops at first distance jump)
 * - 'related': Include related groups (stops at second distance jump)
 */
export type GroupingMode = 'similar' | 'related'

/**
 * VectorStore configuration
 */
export interface VectorStoreConfig {
  /** LanceDB database path */
  dbPath: string
  /** Table name */
  tableName: string
  /** Maximum distance threshold for filtering results (optional) */
  maxDistance?: number
  /** Grouping mode for quality filtering (optional) */
  grouping?: GroupingMode
  /** Hybrid search weight for BM25 (0.0 = vector only, 1.0 = BM25 only, default 0.6) */
  hybridWeight?: number
  /** Maximum number of files to keep in results (optional, filters by best score per file) */
  maxFiles?: number
}

/**
 * Document metadata. Module-private — only consumed internally by the row
 * shapes and `isDocumentMetadata` guard in this file.
 */
interface DocumentMetadata {
  /** File name */
  fileName: string
  /** File size in bytes */
  fileSize: number
  /** File type (extension) */
  fileType: string
}

/**
 * Vector chunk
 */
export interface VectorChunk {
  /** Chunk ID (UUID) */
  id: string
  /** File path (absolute) */
  filePath: string
  /** Chunk index (zero-based) */
  chunkIndex: number
  /** Chunk text */
  text: string
  /** Embedding vector (dimension depends on model) */
  vector: number[]
  /** Metadata */
  metadata: DocumentMetadata
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
  /** Ingestion timestamp (ISO 8601 format) */
  timestamp: string
}

/**
 * Search result
 */
export interface SearchResult {
  /** File path */
  filePath: string
  /** Chunk index */
  chunkIndex: number
  /** Chunk text */
  text: string
  /**
   * Relevance score — **lower is better** in every path. Vector-only: raw dot
   * distance (0 = identical, 1 = orthogonal, 2 = opposite). Hybrid (RRF):
   * `1 - normalizedFusedScore`, so the top fused hit is ~0. Downstream filters
   * (applyGrouping, applyFileFilter) and the MCP `QueryResult.score` all rely on
   * this lower-is-better convention.
   */
  score: number
  /** Metadata */
  metadata: DocumentMetadata
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * Row returned by VectorStore.getChunksByRange.
 * Distinct from SearchResult: no score (not a ranked result) and no metadata
 * (not needed for index-adjacent retrieval). Consumed by
 * handleReadChunkNeighbors and runReadNeighbors.
 */
export interface ChunkRow {
  /** File path (absolute) */
  filePath: string
  /** Chunk index (zero-based) */
  chunkIndex: number
  /** Chunk text */
  text: string
  /** Document title extracted from file content (display-only, not used for scoring) */
  fileTitle: string | null
}

/**
 * Raw result from LanceDB query (internal type)
 */
export interface LanceDBRawResult {
  filePath: string
  chunkIndex: number
  text: string
  metadata: DocumentMetadata
  /** Document title (optional - existing rows lack this field before migration) */
  fileTitle?: string | null
  _distance?: number
  _score?: number
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard for DocumentMetadata
 */
function isDocumentMetadata(value: unknown): value is DocumentMetadata {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['fileName'] === 'string' &&
    typeof obj['fileSize'] === 'number' &&
    typeof obj['fileType'] === 'string'
  )
}

/**
 * Type guard for LanceDB raw search result
 */
export function isLanceDBRawResult(value: unknown): value is LanceDBRawResult {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['filePath'] === 'string' &&
    typeof obj['chunkIndex'] === 'number' &&
    typeof obj['text'] === 'string' &&
    isDocumentMetadata(obj['metadata'])
  )
}

/**
 * Convert LanceDB raw result to SearchResult with type validation
 * @throws DatabaseError if the result is invalid
 */
export function toSearchResult(raw: unknown): SearchResult {
  if (!isLanceDBRawResult(raw)) {
    throw new DatabaseError('Invalid search result format from LanceDB')
  }
  // Score source: vector rows carry `_distance` (dot distance); FTS rows carry
  // `_score` (BM25). Both paths now flow through this mapper — vector results
  // and the independent FTS ranking fed to reciprocalRankFusion. RRF uses each
  // list's ORDER (rank), not this score value, so the exact number here only
  // matters for the vector-only path. The final `?? 0` is a defensive guard for
  // a row missing both fields; not worth failing a whole search over.
  return {
    filePath: raw.filePath,
    chunkIndex: raw.chunkIndex,
    text: raw.text,
    score: raw._distance ?? raw._score ?? 0,
    metadata: raw.metadata,
    fileTitle: raw.fileTitle || null,
  }
}

/**
 * Map a raw LanceDB row to a full {@link VectorChunk}, including the stored
 * embedding vector and metadata. Used for backup/restore (ingest rollback),
 * where the row must round-trip back through `insertChunks` intact — unlike
 * {@link toChunkRow} / {@link toSearchResult}, which drop the vector. The
 * embedding is normalized to `number[]` (LanceDB returns a typed array).
 */
export function toVectorChunk(raw: unknown): VectorChunk {
  if (typeof raw !== 'object' || raw === null) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const obj = raw as Record<string, unknown>
  const { id, filePath, chunkIndex, text, vector, metadata, fileTitle, timestamp } = obj
  if (
    typeof id !== 'string' ||
    typeof filePath !== 'string' ||
    typeof chunkIndex !== 'number' ||
    typeof text !== 'string' ||
    typeof timestamp !== 'string'
  ) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (scalar fields)')
  }
  if (!isDocumentMetadata(metadata)) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (metadata)')
  }
  if (vector == null || typeof (vector as { length?: unknown }).length !== 'number') {
    throw new DatabaseError('Invalid chunk row shape from LanceDB (vector)')
  }
  return {
    id,
    filePath,
    chunkIndex,
    text,
    vector: Array.from(vector as ArrayLike<number>),
    metadata,
    fileTitle: typeof fileTitle === 'string' && fileTitle.length > 0 ? fileTitle : null,
    timestamp,
  }
}

/**
 * Convert LanceDB raw row to ChunkRow with type validation.
 * Mirrors toSearchResult but returns the minimal range-read shape: no score
 * (not ranked) and no metadata (not needed for index-adjacent retrieval).
 *
 * Uses a narrower shape check than isLanceDBRawResult: only
 * filePath/chunkIndex/text are required because getChunksByRange
 * does not project metadata. The empty-string-or-missing fileTitle
 * is normalized to null per §Field Propagation Map.
 *
 * @throws DatabaseError if the raw row is missing required fields
 */
export function toChunkRow(raw: unknown): ChunkRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const obj = raw as Record<string, unknown>
  if (
    typeof obj['filePath'] !== 'string' ||
    typeof obj['chunkIndex'] !== 'number' ||
    typeof obj['text'] !== 'string'
  ) {
    throw new DatabaseError('Invalid chunk row shape from LanceDB')
  }
  const rawFileTitle = obj['fileTitle']
  const fileTitle =
    typeof rawFileTitle === 'string' && rawFileTitle.length > 0 ? rawFileTitle : null
  return {
    filePath: obj['filePath'],
    chunkIndex: obj['chunkIndex'],
    text: obj['text'],
    fileTitle,
  }
}

// ============================================
// Error Classes
// ============================================

// `DatabaseError` lives in `./errors.js` (the per-package error module, mirroring
// `parser/errors.ts`); re-exported here (and imported above for the type guards
// that throw it) so existing `../vectordb/types.js` import sites keep working.
export { DatabaseError }
