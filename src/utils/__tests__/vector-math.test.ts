// vector-math unit tests
// Test Type: Unit Test

import { describe, expect, it } from 'vitest'

import { cosineSimilarity } from '../vector-math.js'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5)
  })

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 5)
  })

  it('returns 0 for length-mismatched vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  it('coalesces missing (undefined) elements to 0', () => {
    const sparse = [1, undefined, 3] as unknown as number[]
    expect(cosineSimilarity(sparse, [1, 5, 3])).toBeCloseTo(
      (1 * 1 + 0 * 5 + 3 * 3) / (Math.sqrt(1 + 0 + 9) * Math.sqrt(1 + 25 + 9)),
      5
    )
  })
})
