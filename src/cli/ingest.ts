// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { randomUUID } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import type { Embedder } from '../embedder/index.js'
import { buildChunksAndEmbeddings } from '../ingest/compute.js'
import { prepareVisualPdfChunks } from '../ingest/visual.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import type { VectorChunk, VectorStore } from '../vectordb/index.js'
import { createEmbedder, createVectorStore } from './common.js'
import type { GlobalOptions, ResolvedGlobalConfig } from './options.js'
import {
  resolveDevice,
  resolveGlobalConfig,
  validateChunkMinLength,
  validateMaxFileSize,
  validatePath,
} from './options.js'

// ============================================
// Constants
// ============================================

const MAX_DEPTH = 10

// ============================================
// Types
// ============================================

interface IngestConfig {
  baseDir: string
  dbPath: string
  cacheDir: string
  modelName: string
  maxFileSize: number
  chunkMinLength?: number
}

interface IngestSummary {
  succeeded: number
  failed: number
  totalChunks: number
}

interface IngestCliOptions {
  baseDir?: string | undefined
  maxFileSize?: number | undefined
  chunkMinLength?: number | undefined
  visual?: boolean | undefined
}

interface ParsedArgs {
  positional: string | undefined
  options: IngestCliOptions
  help: boolean
}

// ============================================
// Defaults
// ============================================

const INGEST_DEFAULTS = {
  maxFileSize: 104857600,
} as const

// ============================================
// Help
// ============================================

const HELP_TEXT = `Usage: mcp-local-rag [global-options] ingest [options] <path>

Ingest a single file or all supported files under a directory.

Options:
  --base-dir <path>        Base directory for documents (default: cwd)
  --max-file-size <n>      Max file size in bytes (default: ${INGEST_DEFAULTS.maxFileSize})
  --chunk-min-length <n>   Minimum chunk length in characters (default: 50, range: 1-10000)
  --visual                 Enable VLM captioning for PDF figure pages (PDFs only; no effect on other types)
  -h, --help               Show this help

Global options (must appear before "ingest"):
  --db-path <path>         LanceDB database path
  --cache-dir <path>       Model cache directory
  --model-name <name>      Embedding model`

// ============================================
// Arg Parsing
// ============================================

/**
 * Parse ingest-specific CLI arguments into options and a positional path.
 * Flags: --base-dir, --max-file-size, -h/--help
 * Unknown flags (including global flags passed after subcommand) cause an error.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const options: IngestCliOptions = {}
  let positional: string | undefined
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
        const value = args[++i]
        if (value === undefined || value.startsWith('-')) {
          console.error('Missing value for --base-dir')
          process.exit(1)
        }
        options.baseDir = value
        i++
        break
      }
      case '--max-file-size': {
        const raw = args[++i]
        if (raw === undefined || raw.startsWith('-')) {
          console.error('Missing value for --max-file-size')
          process.exit(1)
        }
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --max-file-size: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.maxFileSize = Number.parseInt(raw, 10)
        i++
        break
      }
      case '--chunk-min-length': {
        const raw = args[++i]
        if (raw === undefined || raw.startsWith('-')) {
          console.error('Missing value for --chunk-min-length')
          process.exit(1)
        }
        if (!/^\d+$/.test(raw)) {
          console.error(`Invalid value for --chunk-min-length: "${raw.slice(0, 100)}"`)

          process.exit(1)
        }
        options.chunkMinLength = Number.parseInt(raw, 10)
        i++
        break
      }
      case '--visual':
        // Boolean toggle: no value consumed. Mirrors the -h/--help pattern.
        options.visual = true
        i++
        break
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          console.error(HELP_TEXT)
          process.exit(1)
        }
        if (positional !== undefined) {
          console.error(`Unexpected argument: ${arg}`)
          console.error('Only one path is accepted. Use a directory to ingest multiple files.')
          process.exit(1)
        }
        positional = arg
        i++
        break
    }
  }

  return { positional, options, help }
}

// ============================================
// Config Resolution
// ============================================

/**
 * Resolve ingest config by merging global config with ingest-specific options.
 * Ingest-specific: baseDir, maxFileSize (CLI flags > env vars > defaults).
 * Validates all resolved values before returning.
 */
export function resolveConfig(
  globalConfig: ResolvedGlobalConfig,
  ingestOptions: IngestCliOptions = {}
): IngestConfig {
  const baseDir = ingestOptions.baseDir ?? process.env['BASE_DIR'] ?? process.cwd()
  const maxFileSize =
    ingestOptions.maxFileSize ??
    (process.env['MAX_FILE_SIZE']
      ? Number.parseInt(process.env['MAX_FILE_SIZE'], 10)
      : INGEST_DEFAULTS.maxFileSize)
  const chunkMinLength =
    ingestOptions.chunkMinLength ??
    (process.env['CHUNK_MIN_LENGTH']
      ? Number.parseInt(process.env['CHUNK_MIN_LENGTH'], 10)
      : undefined)

  // Validate baseDir path
  const baseDirError = validatePath(baseDir, '--base-dir')
  if (baseDirError) {
    console.error(baseDirError)
    process.exit(1)
  }

  // Validate maxFileSize range
  const maxFileSizeError = validateMaxFileSize(maxFileSize)
  if (maxFileSizeError) {
    console.error(maxFileSizeError)
    process.exit(1)
  }

  // Validate chunkMinLength range (if provided)
  if (chunkMinLength !== undefined) {
    const chunkMinLengthError = validateChunkMinLength(chunkMinLength)
    if (chunkMinLengthError) {
      console.error(chunkMinLengthError)
      process.exit(1)
    }
  }

  const resolved: IngestConfig = {
    dbPath: globalConfig.dbPath,
    cacheDir: globalConfig.cacheDir,
    modelName: globalConfig.modelName,
    baseDir,
    maxFileSize,
  }
  if (chunkMinLength !== undefined) {
    resolved.chunkMinLength = chunkMinLength
  }
  return resolved
}

// ============================================
// File Collection
// ============================================

/**
 * Collect files to ingest from a path.
 * - If path is a file with supported extension, return [path].
 * - If path is a directory, walk with BFS up to MAX_DEPTH levels.
 * - Skip symlinks, permission errors, and excluded directories.
 */
async function collectFiles(targetPath: string, excludePaths: string[]): Promise<string[]> {
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
    return [resolved]
  }

  if (info.isDirectory()) {
    const files: string[] = []
    let depthLimited = false

    const queue: { dirPath: string; depth: number }[] = [{ dirPath: resolved, depth: 0 }]

    while (queue.length > 0) {
      const { dirPath, depth } = queue.shift()!

      if (depth >= MAX_DEPTH) {
        depthLimited = true
        continue
      }

      let dir: Awaited<ReturnType<typeof opendir>>
      try {
        dir = await opendir(dirPath)
      } catch {
        console.error(`Warning: cannot read directory: ${dirPath}`)
        continue
      }

      for await (const entry of dir) {
        const fullPath = join(dirPath, entry.name)

        if (!fullPath.startsWith(resolved)) continue
        if (entry.isSymbolicLink()) continue
        if (excludePaths.some((ep) => fullPath.startsWith(ep))) continue

        if (entry.isDirectory()) {
          queue.push({ dirPath: fullPath, depth: depth + 1 })
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(fullPath)
        }
      }
    }

    if (depthLimited) {
      console.error(
        `Warning: some directories were skipped because they exceed the maximum depth (${MAX_DEPTH})`
      )
    }

    return files.sort()
  }

  return []
}

// ============================================
// Per-file Ingestion
// ============================================

/**
 * Options for `ingestSingleFile`. Discriminated on `visual` so the visual path
 * is type-only callable with the VLM config it actually needs:
 *  - `visual` absent or `false` → no VLM fields required (and not accepted).
 *  - `visual: true` → `vlmModelName` and `cacheDir` required; `device` optional.
 *
 * Why a union rather than always-required fields: making `vlmModelName` /
 * `cacheDir` unconditionally required forces non-visual callers (default-mode
 * tests, future direct-import callers that only ingest non-PDF files) to
 * fabricate VLM config they will never use. The visual-true variant still
 * catches accidental misuse at compile time, which was the original goal.
 */
export type IngestSingleFileOptions =
  | { visual?: false | undefined }
  | {
      visual: true
      vlmModelName: string
      cacheDir: string
      device?: string | undefined
    }

/**
 * Ingest a single file: parse, chunk, embed, delete old chunks, insert new chunks.
 * Returns the number of chunks inserted.
 *
 * When `options.visual === true` AND the file is a `.pdf`, routes through the
 * visual-enrichment path: `parsePdfPages` + VLM captioning (`pdf-visual`
 * orchestrator) + joined-text chunking. `pdf-visual` is loaded via dynamic
 * `await import('../pdf-visual/index.js')` so the default (non-visual) path
 * never pulls the VLM module into the bundle (NFR-1 dynamic-import discipline,
 * verified by AC-001 Proxy sentinel in T4.6).
 *
 * Non-visual, non-PDF, and `visual: true` + non-PDF (silently falls through
 * to the default branch — AC-006) paths are byte-identical to the post-T0.3
 * state and never load `pdf-visual`.
 */
export async function ingestSingleFile(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore,
  options?: IngestSingleFileOptions
): Promise<number> {
  // Parse file
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  let text: string
  let title: string | null = null
  if (options?.visual === true && isPdf) {
    // Visual dispatch — delegates the shared visual-PDF flow to
    // `prepareVisualPdfChunks` (NFR-1: the dynamic `pdf-visual` import lives
    // inside that helper, not here). This branch keeps the CLI persistence
    // model (delete + insert; bulk-loop optimize at the end of `runIngest`).
    //
    // `vlmModelName` and `cacheDir` are required by `prepareVisualPdfChunks`;
    // the CLI bulk-loop always supplies them via the resolved `globalConfig`
    // (see `resolveGlobalConfig` in `cli/options.ts`).
    const visualResult = await prepareVisualPdfChunks(filePath, parser, chunker, embedder, {
      modelName: options.vlmModelName,
      cacheDir: options.cacheDir,
      device: options.device,
    })
    const { chunks, embeddings } = visualResult
    if (chunks.length === 0) {
      console.error(`  Warning: 0 chunks generated (file may be empty or too short)`)
      return 0
    }
    title = visualResult.title

    // Persistence — identical to the default branch below; inlined here so
    // chunks/embeddings produced on the visual path persist correctly. The
    // joined enriched-page text is taken from the helper to preserve the
    // pre-existing `metadata.fileSize` semantics (post-enrichment,
    // pre-chunking text length).
    await vectorStore.deleteChunks(filePath)
    const timestamp = new Date().toISOString()
    const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
      const embedding = embeddings[index]
      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${index}`)
      }
      return {
        id: randomUUID(),
        filePath,
        chunkIndex: chunk.index,
        text: chunk.text,
        vector: embedding,
        metadata: {
          fileName: basename(filePath),
          fileSize: visualResult.text.length,
          fileType: extname(filePath).slice(1),
        },
        fileTitle: title,
        timestamp,
      }
    })
    await vectorStore.insertChunks(vectorChunks)
    return vectorChunks.length
  } else if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  // Chunk text + generate embeddings via the shared computation layer (Phase 0).
  const { chunks, embeddings } = await buildChunksAndEmbeddings(text, title, chunker, embedder)
  if (chunks.length === 0) {
    console.error(`  Warning: 0 chunks generated (file may be empty or too short)`)
    return 0
  }

  // Delete existing chunks for this file
  await vectorStore.deleteChunks(filePath)

  // Build vector chunks
  const timestamp = new Date().toISOString()
  const vectorChunks: VectorChunk[] = chunks.map((chunk, index) => {
    const embedding = embeddings[index]
    if (!embedding) {
      throw new Error(`Missing embedding for chunk ${index}`)
    }
    return {
      id: randomUUID(),
      filePath,
      chunkIndex: chunk.index,
      text: chunk.text,
      vector: embedding,
      metadata: {
        fileName: basename(filePath),
        fileSize: text.length,
        fileType: extname(filePath).slice(1),
      },
      fileTitle: title,
      timestamp,
    }
  })

  // Insert chunks
  await vectorStore.insertChunks(vectorChunks)

  return vectorChunks.length
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run the ingest CLI subcommand.
 * @param args - Arguments after "ingest" (e.g., option flags and file/directory path)
 * @param globalOptions - Global options parsed before the subcommand
 */
export async function runIngest(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  // Parse CLI options
  const { positional, options, help } = parseArgs(args)

  // Handle --help
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  // Validate positional argument
  if (!positional) {
    console.error('Usage: mcp-local-rag ingest [options] <path>')
    console.error('  Ingest a single file or all supported files under a directory.')
    console.error('  Run with --help for all options.')
    process.exit(1)
  }

  const targetPath = positional

  // Validate path exists
  try {
    await stat(targetPath)
  } catch {
    console.error(`Error: path does not exist: ${targetPath}`)
    process.exit(1)
  }

  // Resolve config: CLI flags > env vars > defaults
  const globalConfig = resolveGlobalConfig(globalOptions)
  const config = resolveConfig(globalConfig, options)
  const excludePaths = [`${resolve(config.dbPath)}${sep}`, `${resolve(config.cacheDir)}${sep}`]

  // Collect files
  const files = await collectFiles(targetPath, excludePaths)
  if (files.length === 0) {
    console.error('No supported files found.')
    process.exit(1)
  }

  console.error(`Found ${files.length} file(s) to ingest.`)

  // Initialize components (single instances reused across all files)
  const parser = new DocumentParser({
    baseDir: config.baseDir,
    maxFileSize: config.maxFileSize,
  })
  const chunker = new SemanticChunker(
    config.chunkMinLength !== undefined ? { minChunkLength: config.chunkMinLength } : {}
  )
  const embedder = createEmbedder(globalConfig)
  const vectorStore = createVectorStore(globalConfig)
  await vectorStore.initialize()

  // Process each file
  const summary: IngestSummary = { succeeded: 0, failed: 0, totalChunks: 0 }

  try {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]!
      const label = `[${i + 1}/${files.length}]`

      try {
        // Forward visual + VLM env-resolved options into the per-file ingestor.
        // `ingestSingleFile` routes through the visual path when
        // `options.visual === true && filePath.endsWith('.pdf')`. The two
        // variants of `IngestSingleFileOptions` are built explicitly so the
        // VLM fields only travel with the visual-true branch (the cacheDir is
        // pre-validated by `resolveGlobalConfig` so the captioner does not
        // re-read `process.env['CACHE_DIR']` raw).
        const ingestOptions: IngestSingleFileOptions = options.visual
          ? {
              visual: true,
              vlmModelName: globalConfig.vlmModelName,
              cacheDir: globalConfig.cacheDir,
              device: resolveDevice(process.env['RAG_DEVICE']),
            }
          : { visual: false }
        const chunkCount = await ingestSingleFile(
          filePath,
          parser,
          chunker,
          embedder,
          vectorStore,
          ingestOptions
        )
        if (chunkCount === 0) {
          // 0 chunks is a skip/warning, not a failure
          console.error(`${label} ${filePath} ... SKIPPED (0 chunks)`)
          summary.succeeded++
        } else {
          console.error(`${label} ${filePath} ... OK (${chunkCount} chunks)`)
          summary.succeeded++
          summary.totalChunks += chunkCount
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.error(`${label} ${filePath} ... FAILED: ${reason}`)
        summary.failed++
      }
    }

    // Optimize once at end (not per-file)
    await vectorStore.optimize()
  } finally {
    await embedder.dispose()
    await vectorStore.close()
  }

  // Print summary
  console.error('')
  console.error('--- Ingest Summary ---')
  console.error(`Succeeded: ${summary.succeeded}`)
  console.error(`Failed:    ${summary.failed}`)
  console.error(`Total chunks: ${summary.totalChunks}`)

  if (summary.failed > 0) {
    process.exitCode = 1
  }
}
