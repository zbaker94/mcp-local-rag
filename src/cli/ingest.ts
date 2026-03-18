// CLI ingest subcommand — bulk file ingestion with single optimize() at end

import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { SemanticChunker } from '../chunker/index.js'
import { Embedder } from '../embedder/index.js'
import { DocumentParser, SUPPORTED_EXTENSIONS } from '../parser/index.js'
import type { VectorChunk } from '../vectordb/index.js'
import { VectorStore } from '../vectordb/index.js'

// ============================================
// Types
// ============================================

interface IngestConfig {
  baseDir: string
  dbPath: string
  cacheDir: string
  modelName: string
  maxFileSize: number
}

interface IngestSummary {
  succeeded: number
  failed: number
  totalChunks: number
}

// ============================================
// Config Resolution
// ============================================

function resolveConfig(): IngestConfig {
  return {
    baseDir: process.env['BASE_DIR'] || process.cwd(),
    dbPath: process.env['DB_PATH'] || './lancedb/',
    cacheDir: process.env['CACHE_DIR'] || './models/',
    modelName: process.env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
    maxFileSize: Number.parseInt(process.env['MAX_FILE_SIZE'] || '104857600', 10),
  }
}

// ============================================
// File Collection
// ============================================

/**
 * Collect files to ingest from a path.
 * - If path is a file with supported extension, return [path].
 * - If path is a directory, recursively scan for supported files.
 * - Exclude dbPath and cacheDir directories.
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
    const entries = await readdir(resolved, { recursive: true, withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => join(e.parentPath, e.name))
      .filter((filePath) => !excludePaths.some((ep) => filePath.startsWith(ep)))
      .sort()
  }

  return []
}

// ============================================
// Per-file Ingestion
// ============================================

/**
 * Ingest a single file: parse, chunk, embed, delete old chunks, insert new chunks.
 * Returns the number of chunks inserted.
 */
async function ingestSingleFile(
  filePath: string,
  parser: DocumentParser,
  chunker: SemanticChunker,
  embedder: Embedder,
  vectorStore: VectorStore
): Promise<number> {
  // Parse file
  const isPdf = filePath.toLowerCase().endsWith('.pdf')
  let text: string
  let title: string | null = null
  if (isPdf) {
    const result = await parser.parsePdf(filePath, embedder)
    text = result.content
    title = result.title || null
  } else {
    const result = await parser.parseFile(filePath)
    text = result.content
    title = result.title || null
  }

  // Chunk text
  const chunks = await chunker.chunkText(text, embedder)
  if (chunks.length === 0) {
    console.error(`  Warning: 0 chunks generated (file may be empty or too short)`)
    return 0
  }

  // Generate embeddings
  const embeddings = await embedder.embedBatch(chunks.map((c) => c.text))

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
        fileName: filePath.split('/').pop() || filePath,
        fileSize: text.length,
        fileType: filePath.split('.').pop() || '',
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
 * @param args - Arguments after "ingest" (e.g., file/directory paths)
 */
export async function runIngest(args: string[]): Promise<void> {
  // Validate arguments
  if (args.length !== 1) {
    console.error('Usage: mcp-local-rag ingest <file|directory>')
    console.error('  Ingest a single file or all supported files under a directory.')
    process.exit(1)
  }

  const targetPath = args[0]!

  // Validate path exists
  try {
    await stat(targetPath)
  } catch {
    console.error(`Error: path does not exist: ${targetPath}`)
    process.exit(1)
  }

  // Resolve config from env vars
  const config = resolveConfig()
  const excludePaths = [`${resolve(config.dbPath)}/`, `${resolve(config.cacheDir)}/`]

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
  const chunker = new SemanticChunker()
  const embedder = new Embedder({
    modelPath: config.modelName,
    batchSize: 16,
    cacheDir: config.cacheDir,
  })
  const vectorStore = new VectorStore({
    dbPath: config.dbPath,
    tableName: 'chunks',
  })
  await vectorStore.initialize()

  // Process each file
  const summary: IngestSummary = { succeeded: 0, failed: 0, totalChunks: 0 }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!
    const label = `[${i + 1}/${files.length}]`

    try {
      const chunkCount = await ingestSingleFile(filePath, parser, chunker, embedder, vectorStore)
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

  // Print summary
  console.error('')
  console.error('--- Ingest Summary ---')
  console.error(`Succeeded: ${summary.succeeded}`)
  console.error(`Failed:    ${summary.failed}`)
  console.error(`Total chunks: ${summary.totalChunks}`)

  if (summary.failed > 0) {
    process.exit(1)
  }
  process.exit(0)
}
