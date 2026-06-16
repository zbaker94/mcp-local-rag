// Unit tests for the CLI ingest file-collection / containment logic.
// Test Type: Unit Test
//
// `collectFiles` is the security-adjacent gate that resolves a positional
// ingest path into the concrete file list, rejecting targets outside every
// configured root. Its branches are exercised directly here with `stat`,
// `realpath`, and the shared BFS walk mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  realpath: vi.fn(),
}))
vi.mock('../../utils/scan.js', () => ({
  bfsCollectSupportedFiles: vi.fn(),
}))

import { realpath, stat } from 'node:fs/promises'
import { collectFiles } from '../../cli/file-collection.js'
import { bfsCollectSupportedFiles } from '../../utils/scan.js'

const fileStat = { isFile: () => true, isDirectory: () => false }
const dirStat = { isFile: () => false, isDirectory: () => true }
const otherStat = { isFile: () => false, isDirectory: () => false }

describe('collectFiles', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Identity realpath (no symlinks) for the common case.
    vi.mocked(realpath).mockImplementation((async (p: string) => p) as unknown as typeof realpath)
  })

  afterEach(() => {
    vi.clearAllMocks()
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })

  describe('single-file mode', () => {
    it('returns the resolved path for a supported file under a root', async () => {
      vi.mocked(stat).mockResolvedValue(fileStat as never)

      const result = await collectFiles('/root/docs/a.md', ['/root/docs/'], [])

      expect(result).toEqual(['/root/docs/a.md'])
    })

    it('rejects an unsupported extension with an empty result (no exit)', async () => {
      vi.mocked(stat).mockResolvedValue(fileStat as never)

      const result = await collectFiles('/root/docs/image.png', ['/root/docs/'], [])

      expect(result).toEqual([])
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unsupported file extension'))
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('exits when a supported file is outside every configured root', async () => {
      vi.mocked(stat).mockResolvedValue(fileStat as never)

      await expect(collectFiles('/elsewhere/a.md', ['/root/docs/'], [])).rejects.toThrow(
        'process.exit(1)'
      )
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('is not under any configured base directory')
      )
    })
  })

  describe('directory mode', () => {
    it('returns the deduped, sorted collected files for an in-root directory', async () => {
      vi.mocked(stat).mockResolvedValue(dirStat as never)
      vi.mocked(bfsCollectSupportedFiles).mockResolvedValue({
        files: ['/root/docs/b.md', '/root/docs/a.md', '/root/docs/b.md'],
        unreadableDirs: [],
        depthLimited: false,
      })

      const result = await collectFiles('/root/docs', ['/root/docs/'], [])

      expect(result).toEqual(['/root/docs/a.md', '/root/docs/b.md'])
    })

    it('exits when the directory is outside every configured root', async () => {
      vi.mocked(stat).mockResolvedValue(dirStat as never)

      await expect(collectFiles('/elsewhere', ['/root/docs/'], [])).rejects.toThrow(
        'process.exit(1)'
      )
    })

    it('warns about unreadable directories and a depth limit', async () => {
      vi.mocked(stat).mockResolvedValue(dirStat as never)
      vi.mocked(bfsCollectSupportedFiles).mockResolvedValue({
        files: ['/root/docs/a.md'],
        unreadableDirs: [{ dirPath: '/root/docs/locked', code: 'EACCES' }],
        depthLimited: true,
      })

      const result = await collectFiles('/root/docs', ['/root/docs/'], [])

      expect(result).toEqual(['/root/docs/a.md'])
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read directory'))
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('exceed the maximum depth'))
    })
  })

  it('returns an empty list when the target is neither a file nor a directory', async () => {
    vi.mocked(stat).mockResolvedValue(otherStat as never)

    expect(await collectFiles('/dev/null', ['/root/'], [])).toEqual([])
  })
})
