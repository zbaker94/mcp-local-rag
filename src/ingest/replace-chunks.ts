// Shared transactional chunk-replacement used by both ingest entry points
// (the CLI `ingestSingleFile` bulk loop and the MCP `handleIngestFile` handler).
//
// Backs up a file's existing chunks BEFORE the destructive delete so a failed
// insert rolls back without data loss or vector corruption. Previously the two
// surfaces each inlined this transaction; centralizing it keeps their rollback
// semantics identical and shrinks each handler to orchestration.

import type { VectorChunk } from '../vectordb/index.js'
import { DatabaseError } from '../vectordb/types.js'

/**
 * Minimal vector-store surface the replace transaction needs. Structural so the
 * helper stays decoupled from the concrete `VectorStore` and is easy to mock.
 */
export interface ChunkReplaceStore {
  getChunksByFilePath(filePath: string): Promise<VectorChunk[]>
  deleteChunks(filePath: string): Promise<unknown>
  insertChunks(chunks: VectorChunk[]): Promise<unknown>
  optimize(): Promise<unknown>
}

/**
 * Replace all chunks for `filePath` with `vectorChunks` transactionally.
 *
 * Reads the existing chunks as a backup BEFORE deleting (a read failure
 * propagates here, leaving existing data untouched), deletes, then inserts the
 * new chunks. On insert failure the backup is restored; if the restore also
 * fails a {@link DatabaseError} (cause = the original insert error) is thrown so
 * the caller learns the prior data may be lost. With no backup (new file) the
 * insert error propagates directly and no rollback is attempted.
 *
 * `optimize` controls whether `optimize()` runs after a successful insert (and
 * after a rollback restore): the MCP handler optimizes per call, while the CLI
 * bulk loop omits it and optimizes once after all files.
 */
export async function replaceFileChunks(
  store: ChunkReplaceStore,
  filePath: string,
  vectorChunks: VectorChunk[],
  options: { optimize?: boolean } = {}
): Promise<void> {
  const backup = await store.getChunksByFilePath(filePath)
  await store.deleteChunks(filePath)
  try {
    await store.insertChunks(vectorChunks)
    if (options.optimize) {
      await store.optimize()
    }
  } catch (insertError) {
    if (backup.length > 0) {
      console.error(`Ingestion failed, rolling back ${filePath}...`, insertError)
      try {
        await store.insertChunks(backup)
        if (options.optimize) {
          await store.optimize()
        }
        console.error(`Rollback completed: ${backup.length} chunks restored for ${filePath}`)
      } catch (rollbackError) {
        // Rollback also failed: surface a distinct error so the caller learns
        // the prior data may be lost, not just that the insert failed.
        console.error('Rollback failed:', rollbackError)
        throw new DatabaseError(
          `Ingest failed and rollback failed for ${filePath}; existing data may not have been restored. Original insert error: ${(insertError as Error).message}`,
          insertError as Error
        )
      }
    }
    throw insertError
  }
}
