// Dependency-free vector math helpers shared across the embedding pipeline.

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Returns 0 when the vectors differ in length, are empty, or either has zero
 * magnitude — callers treat "no meaningful similarity" and "undefined" the same
 * way, so a single 0 sentinel keeps the downstream thresholds simple. Missing
 * elements are coalesced to 0 to stay total over sparse inputs.
 */
export function cosineSimilarity(vec1: number[], vec2: number[]): number {
  if (vec1.length !== vec2.length || vec1.length === 0) {
    return 0
  }

  let dotProduct = 0
  let norm1 = 0
  let norm2 = 0

  for (let i = 0; i < vec1.length; i++) {
    const v1 = vec1[i] ?? 0
    const v2 = vec2[i] ?? 0
    dotProduct += v1 * v2
    norm1 += v1 * v1
    norm2 += v2 * v2
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2)
  if (denominator === 0) return 0

  return dotProduct / denominator
}
