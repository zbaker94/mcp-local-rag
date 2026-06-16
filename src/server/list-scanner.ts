// Pure helpers for the RAGServer `list_files` surface and base-dir config
// normalization. Extracted from `RAGServer` so the bounded-BFS directory scan
// and the constructor's config-shape normalization live as standalone,
// behavior-preserving functions independent of instance state.

import { displayPath } from '../utils/base-dirs.js'
import { MAX_SCAN_DEPTH } from '../utils/limits.js'
import { bfsCollectSupportedFiles } from '../utils/scan.js'
import type { RAGServerConfig } from './types.js'

/**
 * Bounded BFS scan of a single base directory for supported files,
 * excluding system-managed paths (dbPath, cacheDir). Returns sorted
 * absolute paths plus a list of non-fatal warnings.
 *
 * Behavior contract:
 *  - Depth is bounded by {@link MAX_SCAN_DEPTH}, mirroring the
 *    CLI ingest walker so the same "how deep do we look under a root"
 *    boundary applies to every list/ingest surface.
 *  - A `readdir` failure under one directory is captured as a warning
 *    rather than aborting the whole list call. One unreadable root must not
 *    hide files under the other roots, so the multi-root contract makes this
 *    asymmetry user-visible, so the policy is now best-effort per root.
 *  - Symlinks are skipped (mirrors the CLI ingest walker).
 */
export async function scanBaseDir(
  baseDir: string,
  excludePaths: readonly string[]
): Promise<{ files: string[]; warnings: string[] }> {
  // Delegate the bounded BFS walk to the shared `bfsCollectSupportedFiles`
  // helper (the single source of truth for depth-bounding, symlink skipping,
  // exclude-prefix filtering, and supported-extension matching); this surface
  // only adds the `list_files` warning wording and the sorted output.
  const { files, unreadableDirs, depthLimited } = await bfsCollectSupportedFiles(
    baseDir,
    excludePaths
  )

  const warnings: string[] = []
  for (const { dirPath, code } of unreadableDirs) {
    warnings.push(`cannot read directory: ${displayPath(dirPath)} (${code})`)
  }
  if (depthLimited) {
    warnings.push(
      `some directories under ${displayPath(baseDir)} were skipped because they exceed the maximum depth (${MAX_SCAN_DEPTH})`
    )
  }

  files.sort()
  return { files, warnings }
}

/**
 * Normalize a {@link RAGServerConfig} into a `{ baseDirs, baseDir }` pair,
 * where `baseDir` is the single-root accessor derived from `baseDirs[0]` (still
 * used for the legacy output-side `list_files` `baseDir` field).
 *
 * Empty `baseDirs` is accepted ONLY in degraded mode (configError set). In
 * that case the server stays constructible so `status` remains callable, but
 * every root-dependent tool fails fast via `assertConfigOk` before any
 * baseDirs-dependent work. Without configError, an empty array is a misuse:
 * reject up front rather than build a parser that silently rejects every path.
 *
 * `baseDir` is empty-string when in degraded mode with an empty `baseDirs`
 * array; it is never consulted there because `assertConfigOk` fires first.
 */
export function normalizeBaseDirs(config: RAGServerConfig): {
  baseDirs: string[]
  baseDir: string
} {
  const normalizedBaseDirs = [...config.baseDirs]
  const firstBaseDir = normalizedBaseDirs[0]
  if (firstBaseDir === undefined && config.configError === undefined) {
    throw new Error(
      'RAGServerConfig requires a non-empty `baseDirs` array (empty `baseDirs` is allowed only in degraded mode with `configError` set).'
    )
  }
  return { baseDirs: normalizedBaseDirs, baseDir: firstBaseDir ?? '' }
}
