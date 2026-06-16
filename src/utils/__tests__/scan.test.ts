// Unit tests for the shared bounded directory scanner.
// Test Type: Unit Test
//
// `bfsCollectSupportedFiles` is a security-adjacent file walker shared by the
// CLI `ingest`/`list` commands and the MCP `list_files` scan, so its
// edge-case branches (exclude-prefix filtering, symlink skipping, depth bound,
// unreadable-directory capture) are exercised here directly rather than only
// transitively through the command tests.

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}))

import { readdir, realpath, stat } from 'node:fs/promises'
import { MAX_SCAN_DEPTH } from '../limits.js'
import { bfsCollectSupportedFiles } from '../scan.js'

type EntryType = 'file' | 'directory' | 'symlink'

function dirent(name: string, type: EntryType = 'file') {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => type === 'symlink',
  }
}

/**
 * Drive the mocked `readdir` from a path→entries map. Paths absent from the map
 * resolve to an empty listing; a path mapped to the `UNREADABLE` sentinel throws
 * an `EACCES`-coded error to exercise the unreadable-directory branch.
 */
const UNREADABLE = Symbol('unreadable')
function setReaddir(map: Record<string, ReturnType<typeof dirent>[] | typeof UNREADABLE>) {
  vi.mocked(readdir).mockImplementation((async (dirPath: string) => {
    const entry = map[dirPath]
    if (entry === UNREADABLE) {
      const err = new Error('permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }
    return entry ?? []
  }) as unknown as typeof readdir)
}

/**
 * Drive the mocked `stat` (target classification for followed symlinks) from a
 * path→type map. A path mapped to `BROKEN` throws ENOENT to exercise the
 * broken-link skip branch; unmapped paths default to a regular file.
 */
const BROKEN = Symbol('broken')
function setStat(map: Record<string, 'file' | 'directory' | typeof BROKEN>) {
  vi.mocked(stat).mockImplementation((async (p: string) => {
    const type = map[p]
    if (type === BROKEN) {
      const err = new Error('no such file') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return {
      isFile: () => type === 'file' || type === undefined,
      isDirectory: () => type === 'directory',
    }
  }) as unknown as typeof stat)
}

/**
 * Drive the mocked `realpath` (cycle guard for followed directory symlinks)
 * from a path→canonical map. Unmapped paths resolve to themselves so links
 * without an explicit alias behave like distinct directories.
 */
function setRealpath(map: Record<string, string> = {}) {
  vi.mocked(realpath).mockImplementation(
    (async (p: string) => map[p] ?? p) as unknown as typeof realpath
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('bfsCollectSupportedFiles', () => {
  it('collects supported files and skips unsupported extensions', async () => {
    setReaddir({
      '/root': [dirent('a.md'), dirent('b.txt'), dirent('image.png'), dirent('notes.pdf')],
    })

    const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles('/root', [])

    expect(files.sort()).toEqual(['/root/a.md', '/root/b.txt', '/root/notes.pdf'])
    expect(unreadableDirs).toEqual([])
    expect(depthLimited).toBe(false)
  })

  it('recurses into subdirectories', async () => {
    setReaddir({
      '/root': [dirent('top.md'), dirent('sub', 'directory')],
      '/root/sub': [dirent('nested.txt')],
    })

    const { files } = await bfsCollectSupportedFiles('/root', [])

    expect(files.sort()).toEqual(['/root/sub/nested.txt', '/root/top.md'])
  })

  it('filters paths under an exclude prefix without excluding a prefix-sharing sibling', async () => {
    setReaddir({
      // Callers pass exclude prefixes WITH a trailing separator, which is what
      // makes the `startsWith` boundary safe: `/root/db/` must exclude the `db`
      // subtree but NOT the sibling `db-backup` that merely shares the prefix.
      '/root': [dirent('keep.md'), dirent('db', 'directory'), dirent('db-backup', 'directory')],
      '/root/db': [dirent('internal.md')],
      '/root/db-backup': [dirent('archived.md')],
    })

    const { files } = await bfsCollectSupportedFiles('/root', ['/root/db/'])

    expect(files.sort()).toEqual(['/root/db-backup/archived.md', '/root/keep.md'])
    expect(files).not.toContain('/root/db/internal.md')
  })

  it('skips symbolic links (neither collected nor traversed)', async () => {
    setReaddir({
      '/root': [dirent('real.md'), dirent('link.md', 'symlink'), dirent('linkdir', 'symlink')],
      // Would be visited only if the symlinked directory were traversed.
      '/root/linkdir': [dirent('hidden.md')],
    })

    const { files } = await bfsCollectSupportedFiles('/root', [])

    expect(files).toEqual(['/root/real.md'])
  })

  describe('followSymlinks', () => {
    it('collects symlinked supported files and traverses symlinked directories', async () => {
      setReaddir({
        '/root': [
          dirent('real.md'),
          dirent('link.md', 'symlink'),
          dirent('image.png', 'symlink'),
          dirent('linkdir', 'symlink'),
        ],
        '/root/linkdir': [dirent('nested.txt')],
      })
      setStat({
        '/root/link.md': 'file',
        '/root/image.png': 'file',
        '/root/linkdir': 'directory',
      })
      setRealpath()

      const { files } = await bfsCollectSupportedFiles('/root', [], MAX_SCAN_DEPTH, true)

      // Symlinked .png skipped (unsupported); link path is kept (not its target).
      expect(files.sort()).toEqual(['/root/link.md', '/root/linkdir/nested.txt', '/root/real.md'])
    })

    it('skips a broken symlink without aborting the scan', async () => {
      setReaddir({
        '/root': [dirent('real.md'), dirent('dead.md', 'symlink')],
      })
      setStat({ '/root/dead.md': BROKEN })
      setRealpath()

      const { files } = await bfsCollectSupportedFiles('/root', [], MAX_SCAN_DEPTH, true)

      expect(files).toEqual(['/root/real.md'])
    })

    it('breaks symlink cycles via the realpath guard', async () => {
      // /root/loop -> (realpath) /root, and /root contains loop again. Without
      // the visited-realpath guard this would recurse until the depth bound.
      setReaddir({
        '/root': [dirent('a.md'), dirent('loop', 'symlink')],
      })
      setStat({ '/root/loop': 'directory' })
      // Both the root and the loop link canonicalize to the same realpath.
      setRealpath({ '/root': '/real', '/root/loop': '/real' })

      const { files, depthLimited } = await bfsCollectSupportedFiles(
        '/root',
        [],
        MAX_SCAN_DEPTH,
        true
      )

      expect(files).toEqual(['/root/a.md'])
      expect(depthLimited).toBe(false)
    })

    it('still skips symlinks when followSymlinks is false (default)', async () => {
      setReaddir({
        '/root': [dirent('real.md'), dirent('link.md', 'symlink')],
      })

      const { files } = await bfsCollectSupportedFiles('/root', [], MAX_SCAN_DEPTH, false)

      expect(files).toEqual(['/root/real.md'])
      expect(stat).not.toHaveBeenCalled()
    })
  })

  it('sets depthLimited when a branch reaches maxDepth and prunes deeper files', async () => {
    // maxDepth = 1: the root (depth 0) is read, its child dir (depth 1) is
    // pruned before being read, so the child's file is never collected.
    setReaddir({
      '/root': [dirent('top.md'), dirent('child', 'directory')],
      '/root/child': [dirent('deep.md')],
    })

    const { files, depthLimited } = await bfsCollectSupportedFiles('/root', [], 1)

    expect(files).toEqual(['/root/top.md'])
    expect(depthLimited).toBe(true)
  })

  it('does not set depthLimited when every branch is within maxDepth', async () => {
    setReaddir({
      '/root': [dirent('top.md'), dirent('child', 'directory')],
      '/root/child': [dirent('deep.md')],
    })

    const { files, depthLimited } = await bfsCollectSupportedFiles('/root', [], 2)

    expect(files.sort()).toEqual(['/root/child/deep.md', '/root/top.md'])
    expect(depthLimited).toBe(false)
  })

  it('captures an unreadable directory with its error code and continues the scan', async () => {
    setReaddir({
      '/root': [dirent('ok.md'), dirent('locked', 'directory'), dirent('open', 'directory')],
      '/root/locked': UNREADABLE,
      '/root/open': [dirent('reachable.txt')],
    })

    const { files, unreadableDirs } = await bfsCollectSupportedFiles('/root', [])

    expect(files.sort()).toEqual(['/root/ok.md', '/root/open/reachable.txt'])
    expect(unreadableDirs).toEqual([{ dirPath: '/root/locked', code: 'EACCES' }])
  })

  it("records 'UNKNOWN' when the readdir failure carries no error code", async () => {
    vi.mocked(readdir).mockImplementation((async () => {
      throw new Error('no code here')
    }) as unknown as typeof readdir)

    const { unreadableDirs } = await bfsCollectSupportedFiles('/root', [])

    expect(unreadableDirs).toEqual([{ dirPath: '/root', code: 'UNKNOWN' }])
  })
})
