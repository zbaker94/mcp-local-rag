// CLI list subcommand — list files and ingestion status

import { readdir } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

import { SUPPORTED_EXTENSIONS } from '../parser/index.js'
import { legacyBaseDir } from '../utils/base-dirs.js'
import { extractSourceFromPath, isRawDataPath } from '../utils/raw-data-utils.js'
import { createVectorStore, resolveCliBaseDirsOrExit } from './common.js'
import type { GlobalOptions } from './options.js'
import { consumeBaseDirArg, resolveGlobalConfig, validatePath } from './options.js'

// ============================================
// Types
// ============================================

interface ListCliOptions {
  /**
   * Collected `--base-dir` values in CLI order. Repeatable: each flag
   * occurrence appends one entry. `undefined` means the flag was not
   * provided.
   */
  baseDirs?: string[] | undefined
}

interface ParsedArgs {
  options: ListCliOptions
  help: boolean
}

interface FileEntry {
  filePath: string
  ingested: boolean
  chunkCount?: number
  timestamp?: string
}

interface SourceEntry {
  source?: string
  filePath?: string
  chunkCount: number
  timestamp: string
}

interface ListResult {
  baseDir: string
  files: FileEntry[]
  sources: SourceEntry[]
}

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] list [options]

List files and their ingestion status.

Options:
  --base-dir <path>      Base directory to scan for files (repeatable: pass once per root; default: BASE_DIRS/BASE_DIR env or cwd)
  -h, --help             Show this help

Global options (must appear before "list"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse list-specific CLI arguments.
 * Flags: --base-dir, -h/--help
 * No positional arguments accepted.
 * Unknown flags cause exit(1).
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: ListCliOptions = {}
  let help = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    switch (arg) {
      case '-h':
      case '--help':
        help = true
        i++
        break
      case '--base-dir': {
        // Repeatable: each `--base-dir <path>` occurrence appends one entry
        // to `options.baseDirs`. The accumulator is lazily initialized so an
        // absent flag leaves `options.baseDirs` as `undefined`, which the
        // resolver treats as "fall through to env / cwd".
        if (options.baseDirs === undefined) {
          options.baseDirs = []
        }
        const valueIndex = consumeBaseDirArg(args, i, options.baseDirs)
        i = valueIndex + 1
        break
      }
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        console.error(`Unexpected argument: ${arg}`)
        console.error('The list command does not accept positional arguments.')
        process.exit(1)
    }
  }

  return { options, help }
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the list CLI subcommand.
 * @param args - Arguments after "list"
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runList(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Resolve global config
  const globalConfig = resolveGlobalConfig(globalOptions)

  // Validate CLI-supplied paths against the sensitive-path policy BEFORE
  // calling the resolver, so the user sees a `--base-dir`-attributed error
  // without an unnecessary realpath round-trip on a rejected path.
  const cliBaseDirs = options.baseDirs ?? []
  for (const root of cliBaseDirs) {
    const baseDirError = validatePath(root, '--base-dir')
    if (baseDirError) {
      console.error(baseDirError)
      process.exit(1)
    }
  }

  // Resolve effective base directories via the shared CLI resolver
  // (CLI > BASE_DIRS > BASE_DIR > cwd). Resolver errors (invalid BASE_DIRS,
  // missing directory, ...) exit non-zero with a clear stderr message and
  // do NOT fall back. Resolver warnings (`base-dirs-overrides-base-dir`,
  // `nested-root-pruned`) are routed to stderr so the JSON-only stdout
  // contract is preserved.
  const { config: baseDirsConfig, warnings: baseDirsWarnings } =
    await resolveCliBaseDirsOrExit(cliBaseDirs)
  for (const warning of baseDirsWarnings) {
    console.error(warning.message)
  }

  // The scan loop still walks a single directory in this task; P2-T2 will
  // switch it to iterate every effective root. `legacyBaseDir` returns the
  // first effective root, which under a single-root configuration is byte-
  // identical to the previous `options.baseDir ?? BASE_DIR ?? cwd` chain.
  const baseDir = legacyBaseDir(baseDirsConfig)

  try {
    // Initialize VectorStore only (no Embedder needed for list)
    const vectorStore = createVectorStore(globalConfig)
    await vectorStore.initialize()

    // Build exclude paths (resolved to absolute, platform-aware trailing separator)
    const excludePaths = [
      `${resolve(globalConfig.dbPath)}${sep}`,
      `${resolve(globalConfig.cacheDir)}${sep}`,
    ]

    // Get all ingested entries from the vector store
    const ingested = await vectorStore.listFiles()
    const ingestedMap = new Map(ingested.map((f) => [f.filePath, f]))

    // Scan baseDir recursively for supported files
    const entries = await readdir(baseDir, { recursive: true, withFileTypes: true })
    const baseDirFiles = entries
      .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => {
        const dir = e.parentPath
        return join(dir, e.name)
      })
      .filter((filePath) => !excludePaths.some((ep) => filePath.startsWith(ep)))
      .sort()

    const baseDirSet = new Set(baseDirFiles)

    // Files in baseDir with ingestion status
    const files: FileEntry[] = baseDirFiles.map((filePath) => {
      const entry = ingestedMap.get(filePath)
      return entry
        ? { filePath, ingested: true, chunkCount: entry.chunkCount, timestamp: entry.timestamp }
        : { filePath, ingested: false }
    })

    // Content ingested via ingest_data (web pages, clipboard, etc.) plus any
    // orphaned DB entries whose files no longer exist on disk
    const sources: SourceEntry[] = ingested
      .filter((f) => !baseDirSet.has(f.filePath))
      .map((f) => {
        if (isRawDataPath(f.filePath)) {
          const source = extractSourceFromPath(f.filePath)
          if (source) return { source, chunkCount: f.chunkCount, timestamp: f.timestamp }
        }
        return { filePath: f.filePath, chunkCount: f.chunkCount, timestamp: f.timestamp }
      })

    const result: ListResult = { baseDir, files, sources }

    // Output JSON to stdout
    process.stdout.write(JSON.stringify(result, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to list files: ${message}`)
    process.exit(1)
  }
}
