// Search filter functions extracted from VectorStore for testability

import type { GroupingMode, SearchResult } from './types.js'

/**
 * Standard deviation multiplier for detecting group boundaries.
 * A gap is considered a "boundary" if it exceeds mean + k*std.
 * Value of 1.5 means gaps > 1.5 standard deviations above mean are boundaries.
 */
const GROUPING_BOUNDARY_STD_MULTIPLIER = 1.5

/**
 * Apply grouping algorithm to filter results by detecting group boundaries.
 *
 * Uses statistical threshold (mean + k*std) to identify significant gaps (group boundaries).
 * - 'similar': Returns only the first group (cuts at first boundary)
 * - 'related': Returns up to 2 groups (cuts at second boundary)
 *
 * @param results - Search results sorted by distance (ascending)
 * @param mode - Grouping mode ('similar' = 1 group, 'related' = 2 groups)
 * @returns Filtered results
 */
export function applyGrouping(results: SearchResult[], mode: GroupingMode): SearchResult[] {
  if (results.length <= 1) return results

  // Calculate gaps between consecutive results with their indices
  const gaps: { index: number; gap: number }[] = []
  for (let i = 0; i < results.length - 1; i++) {
    const current = results[i]
    const next = results[i + 1]
    if (current !== undefined && next !== undefined) {
      gaps.push({ index: i + 1, gap: next.score - current.score })
    }
  }

  if (gaps.length === 0) return results

  // Calculate statistical threshold to identify significant gaps (group boundaries)
  const gapValues = gaps.map((g) => g.gap)
  const mean = gapValues.reduce((a, b) => a + b, 0) / gapValues.length
  const variance = gapValues.reduce((a, b) => a + (b - mean) ** 2, 0) / gapValues.length
  const std = Math.sqrt(variance)
  const threshold = mean + GROUPING_BOUNDARY_STD_MULTIPLIER * std

  // Find all significant gaps (group boundaries)
  const boundaries = gaps.filter((g) => g.gap > threshold).map((g) => g.index)

  // If no boundaries found, return all results
  if (boundaries.length === 0) return results

  // Determine how many groups to include based on mode
  // 'similar': 1 group (cut at first boundary)
  // 'related': 2 groups (cut at second boundary, or return all if only 1 boundary)
  const groupsToInclude = mode === 'similar' ? 1 : 2
  const boundaryIndex = groupsToInclude - 1

  // If we don't have enough boundaries, return all results for 'related' mode
  if (boundaryIndex >= boundaries.length) {
    return mode === 'related' ? results : results.slice(0, boundaries[0])
  }

  // Cut at the appropriate boundary
  return results.slice(0, boundaries[boundaryIndex])
}

/**
 * Apply file-based filter to limit results to chunks from the top N files.
 *
 * Ranks files by their best (lowest distance) chunk score and keeps only
 * chunks belonging to the top `maxFiles` files.
 *
 * @param results - Search results sorted by distance (ascending)
 * @param maxFiles - Maximum number of files to keep
 * @returns Filtered results preserving original order
 */
export function applyFileFilter(results: SearchResult[], maxFiles: number): SearchResult[] {
  if (results.length === 0) return results

  // Find the best (lowest) score per file
  const fileScores = new Map<string, number>()
  for (const result of results) {
    const current = fileScores.get(result.filePath)
    if (current === undefined || result.score < current) {
      fileScores.set(result.filePath, result.score)
    }
  }

  // If we have fewer or equal files than maxFiles, return all
  if (fileScores.size <= maxFiles) return results

  // Sort files by best score (ascending) and take top N
  const topFiles = new Set(
    [...fileScores.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, maxFiles)
      .map(([filePath]) => filePath)
  )

  // Filter results to only include chunks from top files
  return results.filter((result) => topFiles.has(result.filePath))
}

/**
 * Fuse two independently-ranked result lists with Reciprocal Rank Fusion (RRF).
 *
 * RRF combines rankings, not raw scores, which sidesteps the incomparable
 * scales of vector dot-distance and FTS BM25. Each list contributes
 * `weight / (k + rank)` to a document's fused score (rank is the 0-based
 * position in that list). A document present in only one list gets only that
 * list's term, so keyword-only hits (absent from the vector list) can surface.
 *
 * Input ordering IS the rank: `vectorRanked` must be ascending by distance
 * (best first) and `ftsRanked` descending by BM25 (best first) — i.e. both
 * already best-first, as returned by their queries.
 *
 * Output preserves the codebase's lower-is-better convention: the fused score
 * is normalized to (0, 1] and stored as `score = 1 - normalized`, so the top
 * fused hit is ~0 and the list is sorted ascending. When a document appears in
 * both lists, the vector result's row data is kept (it carries the richer
 * fields); only the score is recomputed.
 *
 * `weight` is the **keyword (FTS) influence**, matching the `hybridWeight`
 * config: the FTS list contributes `weight`, the vector list `1 - weight`. So
 * `weight = 1` is keyword-only, `weight = 0` is vector-only.
 *
 * @param vectorRanked - Vector results, best-first
 * @param ftsRanked - FTS results, best-first
 * @param options.k - RRF rank constant (see RRF_K)
 * @param options.weight - Keyword/FTS weight in [0,1]; vector gets `1 - weight`
 */
export function reciprocalRankFusion(
  vectorRanked: SearchResult[],
  ftsRanked: SearchResult[],
  options: { k: number; weight: number }
): SearchResult[] {
  const { k, weight } = options
  const fused = new Map<string, { result: SearchResult; score: number }>()

  const accumulate = (list: SearchResult[], listWeight: number) => {
    list.forEach((result, rank) => {
      const key = `${result.filePath}:${result.chunkIndex}`
      const contribution = listWeight / (k + rank)
      const existing = fused.get(key)
      if (existing) {
        existing.score += contribution
      } else {
        // Vector list is accumulated first, so its richer row data wins on ties.
        fused.set(key, { result, score: contribution })
      }
    })
  }

  accumulate(vectorRanked, 1 - weight)
  accumulate(ftsRanked, weight)

  const entries = [...fused.values()]
  if (entries.length === 0) return []

  // Normalize to (0, 1] then invert so lower = better (top hit ~0).
  const maxScore = entries.reduce((max, e) => (e.score > max ? e.score : max), 0) || 1

  return entries
    .map((e) => ({ ...e.result, score: 1 - e.score / maxScore }))
    .sort((a, b) => a.score - b.score)
}
