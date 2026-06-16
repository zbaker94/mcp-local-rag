// MCP Server entry point
import { resolveDevice, resolveDtype, validateMaxFileSize } from './cli/options.js'
import { RAGServer } from './server/index.js'
import {
  BaseDirsConfigError,
  displayPath,
  parseBaseDirsEnv,
  resolveBaseDirs,
} from './utils/base-dirs.js'
import { DEFAULT_MAX_FILE_SIZE, MAX_FILE_SIZE_LIMIT } from './utils/limits.js'
import { checkSensitivePath } from './utils/sensitive-path.js'
import type { GroupingMode } from './vectordb/index.js'

// ============================================
// Environment Variable Parsers
// ============================================

/** Result of parsing an environment variable */
export interface ParseResult<T> {
  value: T | undefined
  warning?: string
}

/**
 * Parse grouping mode from environment variable
 */
export function parseGroupingMode(value: string | undefined): ParseResult<GroupingMode> {
  if (!value) return { value: undefined }
  const normalized = value.toLowerCase().trim()
  if (normalized === 'similar' || normalized === 'related') {
    return { value: normalized }
  }
  const warning = `Invalid RAG_GROUPING value: "${value.slice(0, 100)}". Expected "similar" or "related". Ignoring.`
  return { value: undefined, warning }
}

/**
 * Parse max distance from environment variable
 */
export function parseMaxDistance(value: string | undefined): ParseResult<number> {
  if (!value) return { value: undefined }
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed <= 0 || !Number.isFinite(parsed)) {
    const warning = `Invalid RAG_MAX_DISTANCE value: "${value.slice(0, 100)}". Expected positive number. Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse max files from environment variable
 */
export function parseMaxFiles(value: string | undefined): ParseResult<number> {
  if (!value) return { value: undefined }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) {
    const warning = `Invalid RAG_MAX_FILES value: "${value.slice(0, 100)}". Expected positive integer (>= 1). Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse hybrid weight from environment variable
 */
export function parseHybridWeight(value: string | undefined): ParseResult<number> {
  if (!value) return { value: undefined }
  const parsed = Number.parseFloat(value)
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    const warning = `Invalid RAG_HYBRID_WEIGHT value: "${value.slice(0, 100)}". Expected 0.0-1.0. Using default (0.6).`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

/**
 * Parse the `RAG_ALLOW_REMOTE_MODELS` environment variable.
 *
 * Accepts common boolean spellings (case-insensitive): `false`/`0`/`no`/`off`
 * disable Hub downloads (offline mode); `true`/`1`/`yes`/`on` keep them
 * enabled. Unset → `undefined` (transformers.js default, downloads allowed).
 * An unrecognized non-empty value is ignored with a warning.
 */
export function parseAllowRemoteModels(value: string | undefined): ParseResult<boolean> {
  if (value === undefined || value.trim().length === 0) return { value: undefined }
  const normalized = value.toLowerCase().trim()
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return { value: false }
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return { value: true }
  }
  const warning = `Invalid RAG_ALLOW_REMOTE_MODELS value: "${value.slice(0, 100)}". Expected a boolean (true/false). Ignoring.`
  return { value: undefined, warning }
}

/**
 * Parse chunk minimum length from environment variable
 */
export function parseChunkMinLength(value: string | undefined): ParseResult<number> {
  if (!value) return { value: undefined }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 10000) {
    const warning = `Invalid CHUNK_MIN_LENGTH value: "${value.slice(0, 100)}". Expected integer between 1 and 10000. Ignoring.`
    return { value: undefined, warning }
  }
  return { value: parsed }
}

// ============================================
// Server Startup
// ============================================

/**
 * Resolve the full RAGServer configuration from environment variables.
 *
 * Pure (no process.exit, no transport): `env` and `cwd` are passed in so the
 * entry-point wiring can be exercised directly in tests instead of via a copy.
 * Single source of truth for BASE_DIRS / BASE_DIR / cwd precedence, the
 * sensitive-path policy on both raw and realpath-normalized roots, and the
 * never-fall-back-to-cwd-on-error rule.
 */
export async function resolveServerConfig(
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<ConstructorParameters<typeof RAGServer>[0]> {
  const device = resolveDevice(env['RAG_DEVICE'])
  // Undefined when RAG_DTYPE is unset — threaded into config only when defined
  // (see below), preserving the unset signal for the embedder's fp32 default.
  const dtype = resolveDtype(env['RAG_DTYPE'])
  const configWarnings: string[] = []

  // Sensitive-path pre-check on the RAW user-supplied paths, before the
  // resolver realpath-normalizes them (on macOS `/etc` → `/private/etc`, which
  // a post-realpath-only check would miss).
  const rawSensitiveErrors: string[] = []
  if (env['BASE_DIRS'] !== undefined && env['BASE_DIRS'].length > 0) {
    const parsed = parseBaseDirsEnv(env['BASE_DIRS'])
    if (parsed.ok) {
      for (const raw of parsed.value) {
        const sensitive = checkSensitivePath(raw, 'BASE_DIRS')
        if (sensitive) rawSensitiveErrors.push(sensitive)
      }
    }
  } else if (env['BASE_DIR'] !== undefined && env['BASE_DIR'].trim().length > 0) {
    const sensitive = checkSensitivePath(env['BASE_DIR'], 'BASE_DIR')
    if (sensitive) rawSensitiveErrors.push(sensitive)
  }

  const baseDirsResult = await resolveBaseDirs({
    envBaseDirs: env['BASE_DIRS'],
    envBaseDir: env['BASE_DIR'],
    cwd,
  })

  let baseDirsForServer: string[]
  // Normal-path roots, index-aligned with baseDirsForServer, for list_files
  // scan/display (see BaseDirsConfig for the path policy).
  let rawBaseDirsForServer: string[]
  let configError: BaseDirsConfigError | undefined
  // Raw sensitive-path matches take precedence over resolver errors.
  if (rawSensitiveErrors.length > 0) {
    baseDirsForServer = []
    rawBaseDirsForServer = []
    configError = new BaseDirsConfigError([...new Set(rawSensitiveErrors)].join('; '))
    configWarnings.push(configError.message)
  } else if (baseDirsResult.ok) {
    const sourceFlag =
      env['BASE_DIRS'] !== undefined && env['BASE_DIRS'].length > 0 ? 'BASE_DIRS' : 'BASE_DIR'
    const sensitiveErrors: string[] = []
    for (const root of baseDirsResult.config.baseDirs) {
      const sensitive = checkSensitivePath(root, sourceFlag)
      if (sensitive) sensitiveErrors.push(sensitive)
    }
    if (sensitiveErrors.length > 0) {
      baseDirsForServer = []
      rawBaseDirsForServer = []
      configError = new BaseDirsConfigError([...new Set(sensitiveErrors)].join('; '))
      configWarnings.push(configError.message)
    } else {
      baseDirsForServer = baseDirsResult.config.baseDirs
      rawBaseDirsForServer = baseDirsResult.config.rawBaseDirs
      for (const warning of baseDirsResult.warnings) {
        configWarnings.push(warning.message)
      }
    }
  } else {
    baseDirsForServer = []
    rawBaseDirsForServer = []
    configError = baseDirsResult.error
    configWarnings.push(baseDirsResult.error.message)
  }

  // Validate MAX_FILE_SIZE the same way the CLI validates --max-file-size.
  // Without this, a non-numeric value parses to NaN and `validateFileSize`'s
  // `stats.size > NaN` comparison is always false — silently disabling the
  // size limit entirely. An out-of-range or invalid value falls back to the
  // default with a surfaced warning instead of a wide-open server.
  let maxFileSize = DEFAULT_MAX_FILE_SIZE
  if (env['MAX_FILE_SIZE'] !== undefined && env['MAX_FILE_SIZE'].trim().length > 0) {
    const parsedMaxFileSize = Number.parseInt(env['MAX_FILE_SIZE'], 10)
    const maxFileSizeError = validateMaxFileSize(parsedMaxFileSize)
    if (maxFileSizeError) {
      configWarnings.push(
        `Invalid MAX_FILE_SIZE value: "${env['MAX_FILE_SIZE'].slice(0, 100)}". Expected an integer between 1 and ${MAX_FILE_SIZE_LIMIT} (500MB). Using default (${DEFAULT_MAX_FILE_SIZE} bytes).`
      )
    } else {
      maxFileSize = parsedMaxFileSize
    }
  }

  const config: ConstructorParameters<typeof RAGServer>[0] = {
    dbPath: env['DB_PATH'] || './lancedb/',
    modelName: env['MODEL_NAME'] || 'Xenova/all-MiniLM-L6-v2',
    cacheDir: env['CACHE_DIR'] || './models/',
    baseDirs: baseDirsForServer,
    rawBaseDirs: rawBaseDirsForServer,
    maxFileSize,
    device,
  }

  // Quality-filter settings: applied only when defined; invalid values warn.
  const maxDistance = parseMaxDistance(env['RAG_MAX_DISTANCE'])
  const grouping = parseGroupingMode(env['RAG_GROUPING'])
  const maxFiles = parseMaxFiles(env['RAG_MAX_FILES'])
  const hybridWeight = parseHybridWeight(env['RAG_HYBRID_WEIGHT'])
  const chunkMinLength = parseChunkMinLength(env['CHUNK_MIN_LENGTH'])
  if (maxDistance.value !== undefined) config.maxDistance = maxDistance.value
  if (maxDistance.warning) configWarnings.push(maxDistance.warning)
  if (grouping.value !== undefined) config.grouping = grouping.value
  if (grouping.warning) configWarnings.push(grouping.warning)
  if (maxFiles.value !== undefined) config.maxFiles = maxFiles.value
  if (maxFiles.warning) configWarnings.push(maxFiles.warning)
  if (hybridWeight.value !== undefined) config.hybridWeight = hybridWeight.value
  if (hybridWeight.warning) configWarnings.push(hybridWeight.warning)
  if (chunkMinLength.value !== undefined) config.chunkMinLength = chunkMinLength.value
  if (chunkMinLength.warning) configWarnings.push(chunkMinLength.warning)

  // Set dtype only when defined, so config.dtype === undefined keeps meaning
  // "RAG_DTYPE unset" (the embedder then applies its fp32 default).
  if (dtype !== undefined) config.dtype = dtype

  // Offline model policy: only thread through when explicitly set, so the
  // transformers.js default (remote downloads allowed) is preserved when unset.
  const allowRemoteModels = parseAllowRemoteModels(env['RAG_ALLOW_REMOTE_MODELS'])
  if (allowRemoteModels.value !== undefined) config.allowRemoteModels = allowRemoteModels.value
  if (allowRemoteModels.warning) configWarnings.push(allowRemoteModels.warning)

  if (configWarnings.length > 0) config.configWarnings = configWarnings
  if (configError !== undefined) config.configError = configError

  return config
}

/**
 * Start the RAG MCP Server
 * Configuration is read from environment variables only (no CLI flags).
 * This ensures the bare `mcp-local-rag` launch is suitable for MCP clients.
 */
export async function startServer(): Promise<void> {
  try {
    const config = await resolveServerConfig(process.env, process.cwd())

    if (config.configWarnings && config.configWarnings.length > 0) {
      console.error('Configuration warnings:', config.configWarnings.join(' | '))
    }

    console.error('Starting RAG MCP Server...')
    // Redact absolute paths (substitute $HOME with ~) before logging so the
    // operating username is not leaked into stderr/log aggregation.
    const loggedConfig = {
      ...config,
      dbPath: displayPath(config.dbPath),
      cacheDir: displayPath(config.cacheDir),
      baseDirs: config.baseDirs?.map(displayPath),
      rawBaseDirs: config.rawBaseDirs?.map(displayPath),
    }
    console.error('Configuration:', loggedConfig)

    // Start RAGServer
    const server = new RAGServer(config)
    await server.initialize()
    await server.run()

    console.error('RAG MCP Server started successfully')
  } catch (error) {
    console.error('Failed to start RAG MCP Server:', error)
    process.exit(1)
  }
}
