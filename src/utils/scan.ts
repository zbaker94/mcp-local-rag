// Shared bounded directory scan for supported document files.
//
// Extracts the BFS traversal mechanism duplicated by the CLI `ingest` walker,
// the CLI `list` walker, and the MCP server's `list_files` scan: bounded depth,
// symlink skipping, exclude-path filtering, and supported-extension matching.
//
// Presentation (warning wording, when/where warnings are surfaced) and
// post-processing (sort/dedup) stay with each caller — this helper returns
// structured facts (`unreadableDirs`, `depthLimited`) so callers preserve
// their own, intentionally-different, user-facing messages.

import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { MAX_SCAN_DEPTH } from './limits.js'
import { SUPPORTED_EXTENSIONS } from './supported-extensions.js'

/**
 * Canonical identity key for the `list`/`list_files` cross-reference: a file's
 * realpath, falling back to the input path when realpath fails (orphaned or
 * raw-data entries). Matching ingested DB entries against scanned files by this
 * key recognizes the same physical file across symlinked spellings (prefix or
 * alias). Storage, lookup, and display still use the normal resolve() path —
 * realpath here is the file-identity comparison, not a user-facing value.
 */
export async function realpathForMatch(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch {
    return filePath
  }
}

/**
 * A directory that could not be read during the scan. Module-private — only
 * surfaced inside the `ScanResult` returned by the collector in this file.
 */
interface UnreadableDir {
  dirPath: string
  /** Node error `code` (e.g. `EACCES`), or `'UNKNOWN'` when unavailable. */
  code: string
}

/** Structured result of a bounded directory scan. */
export interface DirScanResult {
  /** Supported files found under the root, in BFS-discovery order (unsorted). */
  files: string[]
  /** Directories skipped because `readdir` failed (caller decides how to warn). */
  unreadableDirs: UnreadableDir[]
  /** True if any branch was pruned for exceeding `maxDepth`. */
  depthLimited: boolean
}

/**
 * Bounded BFS scan of a single root, collecting every supported file up to
 * `maxDepth` levels deep. Paths under any `excludePaths` prefix are filtered
 * out. A per-directory `readdir` failure is captured into `unreadableDirs` and
 * does not abort the scan (best-effort per directory).
 *
 * Symlinks are skipped by default. When `followSymlinks` is true, a symlink to
 * a directory is traversed and a symlink to a supported file is collected — the
 * collected/enqueued path is the symlink's own path (not its target), so DB
 * keys keep the spelling under `rootPath`; the read-time security boundary in
 * `DocumentParser` still realpaths each file and rejects any whose target
 * escapes all configured roots, so following links never widens the boundary.
 * Followed directory targets are tracked by realpath to break symlink cycles.
 *
 * Does not sort, dedupe, or emit warnings — callers handle those so their
 * existing output contracts are preserved.
 */
export async function bfsCollectSupportedFiles(
  rootPath: string,
  excludePaths: readonly string[],
  maxDepth: number = MAX_SCAN_DEPTH,
  followSymlinks = false
): Promise<DirScanResult> {
  const files: string[] = []
  const unreadableDirs: UnreadableDir[] = []
  let depthLimited = false

  // Realpaths of directories already enqueued via a followed symlink — the
  // loop guard that stops `a -> b -> a` symlink cycles from looping forever.
  // Seeded with the root so a child link pointing back to the root is pruned.
  const visitedDirRealpaths = new Set<string>()
  if (followSymlinks) {
    try {
      visitedDirRealpaths.add(await realpath(rootPath))
    } catch {
      // Root unresolvable (e.g. broken link) — readdir below will surface it.
    }
  }

  const queue: { dirPath: string; depth: number }[] = [{ dirPath: rootPath, depth: 0 }]

  while (queue.length > 0) {
    const { dirPath, depth } = queue.shift()!

    if (depth >= maxDepth) {
      depthLimited = true
      continue
    }

    // TypeScript's `readdir` has overloads keyed on the options shape; pin the
    // encoding to `'utf8'` and cast so the loop operates on string-encoded
    // Dirent entries (matches the rest of the codebase).
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = (await readdir(dirPath, {
        withFileTypes: true,
        encoding: 'utf8',
      })) as import('node:fs').Dirent<string>[]
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? ((error as NodeJS.ErrnoException).code ?? 'UNKNOWN')
          : 'UNKNOWN'
      unreadableDirs.push({ dirPath, code })
      continue
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (excludePaths.some((ep) => fullPath.startsWith(ep))) continue

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue
        // `stat` (not `lstat`) resolves the link to classify its target. A
        // broken or unreadable link throws and is skipped — the read boundary
        // would reject it anyway.
        let target: import('node:fs').Stats
        try {
          target = await stat(fullPath)
        } catch {
          continue
        }
        if (target.isDirectory()) {
          // Cycle guard: enqueue a followed directory only once per realpath.
          let real: string
          try {
            real = await realpath(fullPath)
          } catch {
            continue
          }
          if (visitedDirRealpaths.has(real)) continue
          visitedDirRealpaths.add(real)
          queue.push({ dirPath: fullPath, depth: depth + 1 })
        } else if (target.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(fullPath)
        }
        continue
      }

      if (entry.isDirectory()) {
        queue.push({ dirPath: fullPath, depth: depth + 1 })
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }
  }

  return { files, unreadableDirs, depthLimited }
}
