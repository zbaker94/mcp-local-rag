#!/usr/bin/env node

// Entry point for mcp-local-rag
// Routes to CLI subcommands or starts the MCP server

import { parseGlobalOptions } from './cli/options.js'
import { handleCli } from './cli-main.js'
import { startServer } from './server-main.js'

// ============================================
// Routing
// ============================================

const SUBCOMMANDS = new Set([
  'skills',
  'ingest',
  'list',
  'query',
  'status',
  'delete',
  'read-neighbors',
])

const { globalOptions, remainingArgs } = parseGlobalOptions(process.argv.slice(2))
const firstArg = remainingArgs[0]

if (firstArg && SUBCOMMANDS.has(firstArg)) {
  // CLI subcommand
  handleCli(remainingArgs, globalOptions).catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else if (remainingArgs.length === 0) {
  if (Object.keys(globalOptions).length > 0) {
    console.error('Global CLI options are not supported when launching the MCP server directly.')
    console.error(
      'Use environment variables like DB_PATH, CACHE_DIR, MODEL_NAME, BASE_DIR, and MAX_FILE_SIZE instead.'
    )
    process.exit(1)
  }

  // Default: start MCP server (env-only, no CLI flags)
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason)
    process.exit(1)
  })

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error)
    process.exit(1)
  })

  startServer()
} else {
  console.error(`Unknown command: ${firstArg}`)
  console.error('Available commands: skills, ingest, list, query, status, delete, read-neighbors')
  process.exit(1)
}
