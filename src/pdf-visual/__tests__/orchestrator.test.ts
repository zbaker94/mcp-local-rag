// T3.4 — `enrichPagesWithCaptions` unit tests (AC-003, AC-004).
//
// Asserts the orchestrator's public contract documented in
// docs/design/vlm-pdf-enrichment-design.md §Component → pdf-visual/index.ts
// — `enrichPagesWithCaptions` orchestrator:
//
//   enrichPagesWithCaptions(
//     pages: Array<{ pageNum, text, stextJson }>,
//     candidates: Array<{ pageNum, isCandidate }>,
//     doc: MupdfDocument,
//     captioner: Captioner
//   ): Promise<Array<{ pageNum, text, stextJson }>>
//
// Verification points (per task file Red Phase):
//   - AC-003: when no candidate has `isCandidate === true`, the captioner is
//     never invoked (call count 0). Also implies the renderer is never invoked.
//   - AC-004: per-page captioner failures are swallowed. The failing page's
//     text is left unchanged (no `[Visual content on page N: ` substring),
//     while subsequent candidate pages receive their caption normally. A
//     warn/error-level log line names the failed page.
//   - null caption: when the captioner returns `null`, the page text is left
//     unchanged AND a warn log line names the page (DD: null → warn log,
//     same effect as failure but distinct log channel).
//   - Happy path: a candidate page receives
//     `[Visual content on page N: <caption>]` appended to its text (joined
//     with `\n\n` when prior text is non-empty).
//
// Renderer and captioner are mocked via `vi.hoisted` per the project-wide
// constraint (`vitest.config.mjs` sets `isolate: false`, so mock factories
// must be hoisted to be visible inside `vi.mock` before the SUT imports the
// module).

import type { Document as MupdfDocument } from 'mupdf'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================
// Mocks (vi.hoisted — required for `../renderer` and `../captioner`)
// ============================================

const mocks = vi.hoisted(() => {
  // Shared state controllable from individual tests.
  const state: {
    // Page-keyed captioner behaviour. If absent, `defaultCaption` is returned.
    captionByPage: Map<number, string | null | Error>
    defaultCaption: string | null
    // Page-keyed renderer behaviour. If absent, `defaultPng` is returned.
    renderByPage: Map<number, Error>
    defaultPng: Uint8Array
  } = {
    captionByPage: new Map(),
    defaultCaption: 'a generic caption',
    renderByPage: new Map(),
    defaultPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  }

  const renderSpy = vi.fn(async (_doc: unknown, pageNum: number): Promise<Uint8Array> => {
    const override = state.renderByPage.get(pageNum)
    if (override) throw override
    return state.defaultPng
  })

  const captionSpy = vi.fn(async (_png: Uint8Array, pageNum: number): Promise<string | null> => {
    const override = state.captionByPage.get(pageNum)
    if (override instanceof Error) throw override
    if (override !== undefined) return override
    return state.defaultCaption
  })

  return { state, renderSpy, captionSpy }
})

vi.mock('../renderer.js', () => ({
  renderPdfPage: mocks.renderSpy,
}))

vi.mock('../captioner.js', () => ({
  // The orchestrator imports `Captioner` from `../types.js`, not from here,
  // so we only need to ensure this module load resolves cleanly during tests
  // that may transitively import it. Provide a no-op `createCaptioner`.
  createCaptioner: vi.fn(),
}))

// Import the SUT AFTER the mocks are installed. ESM hoists `import`, but
// `vi.mock` is also hoisted by vitest's transformer, so this ordering is the
// project-wide convention.
import { enrichPagesWithCaptions } from '../index.js'
import type { Captioner } from '../types.js'

// ============================================
// Helpers
// ============================================

type PageRecord = { pageNum: number; text: string; stextJson: unknown }

function makePages(specs: Array<{ pageNum: number; text: string }>): PageRecord[] {
  return specs.map((s) => ({
    pageNum: s.pageNum,
    text: s.text,
    // The orchestrator does not read stextJson; pass through opaquely.
    stextJson: { blocks: [] },
  }))
}

// The orchestrator receives a `Captioner` instance and calls `.caption(...)`
// on it. We wire the hoisted spy through here so individual tests can adjust
// `mocks.state` to control behaviour.
const captioner: Captioner = {
  caption: (png, pageNum) => mocks.captionSpy(png, pageNum),
}

// `doc` is forwarded verbatim to `renderPdfPage`, which is mocked, so any
// sentinel object is fine.
const fakeDoc = { _sentinel: 'mupdf-doc' } as unknown as MupdfDocument

// ============================================
// Tests
// ============================================

describe('enrichPagesWithCaptions', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Reset shared state between tests.
    mocks.state.captionByPage = new Map()
    mocks.state.defaultCaption = 'a generic caption'
    mocks.state.renderByPage = new Map()
    mocks.renderSpy.mockClear()
    mocks.captionSpy.mockClear()
    // Silence and capture console output. Use `mockImplementation` (not
    // `mockReturnValue`) so the original method is fully shadowed.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('AC-003: skips captioner entirely when no page is a visual candidate', async () => {
    // Arrange: detector marks every page as not-a-candidate.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
      { pageNum: 3, text: 'page three body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: false },
      { pageNum: 3, isCandidate: false },
    ]

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert: zero VLM invocations (the AC-003 invariant) and zero renderer
    // invocations (no point rendering a page we will not caption).
    expect(mocks.captionSpy).toHaveBeenCalledTimes(0)
    expect(mocks.renderSpy).toHaveBeenCalledTimes(0)
    // Texts pass through unchanged.
    expect(result.map((p) => p.text)).toEqual(['page one body', 'page two body', 'page three body'])
  })

  it('AC-004: a single page captioner failure is swallowed; other pages still get captions', async () => {
    // Arrange: pages 2 and 3 are candidates. Captioner throws on page 2 and
    // returns a real caption on page 3.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
      { pageNum: 3, text: 'page three body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true },
      { pageNum: 3, isCandidate: true },
    ]
    mocks.state.captionByPage.set(2, new Error('simulated VLM failure'))
    mocks.state.captionByPage.set(3, 'bar chart with X axis labels')

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert
    const byPage = new Map(result.map((p) => [p.pageNum, p.text]))
    // Page 2 failure was swallowed — no caption bracket appended.
    expect(byPage.get(2)).toBe('page two body')
    expect(byPage.get(2)).not.toContain('[Visual content on page 2:')
    // Page 3 happy path — caption appended in the documented format.
    expect(byPage.get(3)).toContain('[Visual content on page 3: bar chart with X axis labels]')
    // A log line names page 2. The DD specifies error-level for throw paths
    // and warn-level for null paths; either log channel is acceptable for the
    // throw path so long as the page number is captured.
    const allLogMessages = [...warnSpy.mock.calls.flat(), ...errorSpy.mock.calls.flat()]
      .map((arg) => (typeof arg === 'string' ? arg : ''))
      .join(' | ')
    expect(allLogMessages).toMatch(/page 2/)
  })

  it('warns and leaves text unchanged when captioner returns null (empty caption)', async () => {
    // Arrange: page 2 is a candidate, captioner returns `null` (DD: null
    // post-sanitization → warn log, no caption appended).
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true },
    ]
    mocks.state.captionByPage.set(2, null)

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert
    const byPage = new Map(result.map((p) => [p.pageNum, p.text]))
    expect(byPage.get(2)).toBe('page two body')
    expect(byPage.get(2)).not.toContain('[Visual content on page 2:')
    // The null path must be warn-level, not error-level (it is not a failure).
    const warnMessages = warnSpy.mock.calls
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : ''))
      .join(' | ')
    expect(warnMessages).toMatch(/page 2/)
    // And no error log for the null case (it is the documented non-error skip).
    expect(errorSpy).toHaveBeenCalledTimes(0)
  })

  it('happy path: appends [Visual content on page N: <caption>] to candidate page text', async () => {
    // Arrange: page 2 is the sole candidate.
    const pages = makePages([
      { pageNum: 1, text: 'page one body' },
      { pageNum: 2, text: 'page two body' },
    ])
    const candidates = [
      { pageNum: 1, isCandidate: false },
      { pageNum: 2, isCandidate: true },
    ]
    mocks.state.captionByPage.set(2, 'pie chart 40 / 35 / 25 percent')

    // Act
    const result = await enrichPagesWithCaptions(pages, candidates, fakeDoc, captioner)

    // Assert: exact bracket format per DD line 736.
    const byPage = new Map(result.map((p) => [p.pageNum, p.text]))
    expect(byPage.get(2)).toBe(
      'page two body\n\n[Visual content on page 2: pie chart 40 / 35 / 25 percent]'
    )
    // Page 1 (non-candidate) untouched.
    expect(byPage.get(1)).toBe('page one body')
    // The candidate page invoked the renderer and the captioner exactly once.
    expect(mocks.renderSpy).toHaveBeenCalledTimes(1)
    expect(mocks.renderSpy).toHaveBeenCalledWith(fakeDoc, 2)
    expect(mocks.captionSpy).toHaveBeenCalledTimes(1)
    expect(mocks.captionSpy).toHaveBeenCalledWith(mocks.state.defaultPng, 2)
  })
})
