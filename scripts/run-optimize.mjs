// One-off: re-run VectorStore.optimize() after a bulk ingest whose final
// optimize panicked. dbPath from argv[2] or DB_PATH. Disposable.
import { VectorStore } from '../dist/vectordb/index.js'

const dbPath = process.argv[2] ?? process.env.DB_PATH
if (!dbPath) {
  console.error('usage: node run-optimize.mjs <db-path>')
  process.exit(2)
}

const store = new VectorStore({ dbPath, tableName: 'chunks' })
await store.initialize()
console.error('optimizing…')
await store.optimize()
console.error('optimize OK')
