// Unit tests for the shared transactional chunk-replacement helper.
// Test Type: Unit Test

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VectorChunk } from '../../vectordb/index.js'
import { DatabaseError } from '../../vectordb/types.js'
import { type ChunkReplaceStore, replaceFileChunks } from '../replace-chunks.js'

function chunk(index: number): VectorChunk {
  return {
    filePath: '/f.md',
    chunkIndex: index,
    text: `chunk ${index}`,
    vector: [index],
  } as unknown as VectorChunk
}

function makeStore(backup: VectorChunk[]): ChunkReplaceStore & {
  getChunksByFilePath: ReturnType<typeof vi.fn>
  deleteChunks: ReturnType<typeof vi.fn>
  insertChunks: ReturnType<typeof vi.fn>
  optimize: ReturnType<typeof vi.fn>
} {
  return {
    getChunksByFilePath: vi.fn().mockResolvedValue(backup),
    deleteChunks: vi.fn().mockResolvedValue(undefined),
    insertChunks: vi.fn().mockResolvedValue(undefined),
    optimize: vi.fn().mockResolvedValue(undefined),
  }
}

describe('replaceFileChunks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('backs up, deletes, then inserts the new chunks', async () => {
    const store = makeStore([chunk(0)])
    const next = [chunk(0), chunk(1)]

    await replaceFileChunks(store, '/f.md', next)

    expect(store.getChunksByFilePath).toHaveBeenCalledWith('/f.md')
    expect(store.deleteChunks).toHaveBeenCalledWith('/f.md')
    expect(store.insertChunks).toHaveBeenCalledWith(next)
  })

  it('omits optimize() by default and runs it when requested', async () => {
    const deferred = makeStore([])
    await replaceFileChunks(deferred, '/f.md', [chunk(0)])
    expect(deferred.optimize).not.toHaveBeenCalled()

    const eager = makeStore([])
    await replaceFileChunks(eager, '/f.md', [chunk(0)], { optimize: true })
    expect(eager.optimize).toHaveBeenCalledTimes(1)
  })

  it('restores the backup when the insert fails', async () => {
    const store = makeStore([chunk(0)])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.insertChunks
      .mockRejectedValueOnce(new Error('insert boom'))
      .mockResolvedValueOnce(undefined)

    await expect(replaceFileChunks(store, '/f.md', [chunk(1)])).rejects.toThrow('insert boom')

    // Second insert is the backup restore.
    expect(store.insertChunks).toHaveBeenCalledTimes(2)
    expect(store.insertChunks).toHaveBeenLastCalledWith([chunk(0)])
    errSpy.mockRestore()
  })

  it('does not attempt a rollback when there is no backup (new file)', async () => {
    const store = makeStore([])
    store.insertChunks.mockRejectedValueOnce(new Error('insert boom'))

    await expect(replaceFileChunks(store, '/f.md', [chunk(0)])).rejects.toThrow('insert boom')

    // Only the original insert; no restore.
    expect(store.insertChunks).toHaveBeenCalledTimes(1)
  })

  it('throws DatabaseError (cause = insert error) when the rollback also fails', async () => {
    const store = makeStore([chunk(0)])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const insertError = new Error('insert boom')
    store.insertChunks
      .mockRejectedValueOnce(insertError)
      .mockRejectedValueOnce(new Error('restore boom'))

    const caught = await replaceFileChunks(store, '/f.md', [chunk(1)]).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(DatabaseError)
    expect((caught as DatabaseError).message).toMatch(/rollback failed/)
    expect((caught as DatabaseError).cause).toBe(insertError)
    errSpy.mockRestore()
  })
})
