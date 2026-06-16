// CLI ingest file collection.
//
// Resolves the positional ingest path into the concrete list of supported
// files to ingest. Single-file mode validates the extension; directory mode
// confirms the path is inside a configured root and delegates the bounded
// BFS walk to `bfsCollectSupportedFiles`. Out-of-root directory targets exit
// the process (preserved from the original inline implementation).
//
// `followSymlinks` (default false) is forwarded to the directory walk so the
// `ingest --follow-symlinks` flag can traverse symlinked trees; the read-time
// root boundary in `DocumentParser` still gates every resolved target.

import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'

export async function collectFiles(
  targetPath: string,
  baseDirs: readonly string[],
  excludePaths: string[],
  followSymlinks = false
): Promise<string[]> {
  const resolved = resolve(targetPath)
  const info = await stat(resolved)

  if (info.isFile()) {
    const ext = extname(resolved).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.error(
        `Unsupported file extension: ${ext} (supported: ${[...SUPPORTED_EXTENSIONS].join(', ')})`
      )
      return []
    }
    // Confirm the file lives under a configured root, mirroring the directory
    // branch below. The parser still enforces containment at read time, but
    // without this check the file and directory branches were inconsistent —
    // a single-file target outside every root was silently accepted here and
    // only rejected later with a less actionable error. realpath both sides
    // (roots are already realpath-normalized with a trailing sep) so the prefix
    // check is symlink-safe and sibling-prefix safe.
    const realResolvedFile = await realpath(resolved)
    const insideAnyRoot = baseDirs.some((root) => realResolvedFile.startsWith(root))
    if (!insideAnyRoot) {
      console.error(
        `Error: ${targetPath} is not under any configured base directory. ` +
          `Allowed roots: ${baseDirs.join(', ')}. ` +
          `Provide a path inside one of the configured roots, or set BASE_DIRS / --base-dir to include the desired tree.`
      )
      process.exit(1)
    }
    // Store the resolve()'d path (the DB key), not realpath — path policy:
    // realpath only at the security boundary, resolve() everywhere user-facing.
    return [resolved]
  }

  if (info.isDirectory()) {
    // realpath both sides so a symlinked positional path still matches a
    // root whose realpath agrees. baseDirs from resolveCliBaseDirsOrExit
    // are already realpath-normalized with a trailing sep.
    const realResolved = await realpath(resolved)
    const realResolvedWithSep = realResolved.endsWith(sep) ? realResolved : realResolved + sep
    const insideAnyRoot = baseDirs.some(
      (root) => realResolvedWithSep === root || realResolvedWithSep.startsWith(root)
    )
    if (!insideAnyRoot) {
      console.error(
        `Error: ${targetPath} is not under any configured base directory. ` +
          `Allowed roots: ${baseDirs.join(', ')}. ` +
          `Provide a path inside one of the configured roots, or set BASE_DIRS / --base-dir to include the desired tree.`
      )
      process.exit(1)
    }

    // `realResolved` is used ONLY for the in-root containment check (security).
    // The walk uses the resolve()'d `resolved` so the stored DB keys match what
    // `list`/`delete`/`read_chunk_neighbors` use (resolve(), not realpath).
    const {
      files: collected,
      unreadableDirs,
      depthLimited,
    } = await bfsCollectSupportedFiles(resolved, excludePaths, MAX_SCAN_DEPTH, followSymlinks)

    for (const { dirPath } of unreadableDirs) {
      console.error(`Warning: cannot read directory: ${dirPath}`)
    }

    if (depthLimited) {
      console.error(
        `Warning: some directories were skipped because they exceed the maximum depth (${MAX_SCAN_DEPTH})`
      )
    }

    return [...new Set(collected)].sort()
  }

  return []
}
