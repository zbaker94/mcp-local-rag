// Code-aware chunker using tree-sitter (web-tree-sitter, WASM grammars).
//
// Splits source files at AST boundaries — functions, classes, interfaces,
// imports — instead of the sentence-similarity windows the SemanticChunker uses
// for prose. Top-level constructs each become a chunk (with any leading
// comment/docstring attached); consecutive small statements (imports, simple
// declarations) are merged, and oversized constructs are split on line
// boundaries to bound chunk size.
//
// WASM (web-tree-sitter + prebuilt tree-sitter-wasms grammars) is used instead
// of native tree-sitter bindings to avoid native-binary compilation. Parser
// runtime init and per-language grammar loads are cached at module scope and
// are lazy, so a server that never ingests code pays nothing.

import { createRequire } from 'node:module'
import Parser from 'web-tree-sitter'
import type { Chunker, EmbedderInterface, TextChunk } from './types.js'

/** Languages with a wired-up tree-sitter grammar. */
export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'java'

/** Map a file extension (lowercase, with dot) to a code language, or null. */
export function codeLanguageForExtension(ext: string): CodeLanguage | null {
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.tsx':
      return 'tsx'
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript'
    case '.py':
      return 'python'
    case '.java':
      return 'java'
    default:
      return null
  }
}

const WASM_FILE: Record<CodeLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
}

// Node types that each deserve their own chunk (both at top level and as class
// members). export_statement (TS/JS) and decorated_definition (Python) wrap the
// inner function/class, so they capture "export function foo" / "@decorator\ndef
// foo" as one unit. method_definition / method_declaration / constructor_*
// appear as class members and are split out when a large class is decomposed.
const TS_JS_BOUNDARY = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'export_statement',
  'method_definition',
])
const PYTHON_BOUNDARY = new Set(['function_definition', 'class_definition', 'decorated_definition'])
const JAVA_BOUNDARY = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
  'method_declaration',
  'constructor_declaration',
])
const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment'])

// Boundary nodes whose body members are split into their own chunks when the
// node is larger than maxChunkChars. (export_statement / decorated_definition
// are unwrapped to their inner declaration first; see getContainerBody.)
const CONTAINER_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
  'class_definition', // python
  'record_declaration', // java
  'annotation_type_declaration', // java
])
// Body nodes that hold a container's members.
const BODY_TYPES = new Set([
  'class_body',
  'enum_body',
  'interface_body',
  'annotation_type_body',
  'object_type', // ts interface body
  'declaration_list',
  'block', // python
])

const DEFAULT_MAX_CHUNK_CHARS = 2000

function boundaryFor(language: CodeLanguage): Set<string> {
  if (language === 'python') return PYTHON_BOUNDARY
  if (language === 'java') return JAVA_BOUNDARY
  return TS_JS_BOUNDARY
}

/**
 * If `node` is a member-bearing container (after unwrapping export_statement /
 * decorated_definition), return its body node; otherwise null. Used to decide
 * whether a large boundary node should be split into per-member chunks.
 */
function getContainerBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let target = node
  if (node.type === 'export_statement' || node.type === 'decorated_definition') {
    target = node.namedChildren.find((c) => CONTAINER_TYPES.has(c.type)) ?? node
  }
  if (!CONTAINER_TYPES.has(target.type)) return null
  return target.namedChildren.find((c) => BODY_TYPES.has(c.type)) ?? null
}

/** Reusable Parser.init() — idempotent, runs the WASM runtime bootstrap once. */
let parserInitPromise: Promise<void> | null = null
function ensureParserInit(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init()
  }
  return parserInitPromise
}

// Grammars are immutable once loaded; cache per language across all chunkers.
const languageCache = new Map<CodeLanguage, Parser.Language>()
const requireFromHere = createRequire(import.meta.url)

async function loadLanguage(language: CodeLanguage): Promise<Parser.Language> {
  const cached = languageCache.get(language)
  if (cached) return cached
  const wasmPath = requireFromHere.resolve(`tree-sitter-wasms/out/${WASM_FILE[language]}`)
  const loaded = await Parser.Language.load(wasmPath)
  languageCache.set(language, loaded)
  return loaded
}

export interface CodeChunkerConfig {
  /** Source language (selects the grammar). */
  language: CodeLanguage
  /** Chunks shorter than this (trimmed) are merged into a neighbor. Default 50. */
  minChunkLength?: number
  /** Constructs larger than this are split on line boundaries. Default 2000. */
  maxChunkChars?: number
}

/**
 * Code-aware chunker. Implements the shared {@link Chunker} contract; the
 * `embedder` argument is accepted for interface parity but unused (AST
 * boundaries are deterministic — no embeddings needed).
 */
export class CodeChunker implements Chunker {
  private readonly language: CodeLanguage
  private readonly minChunkLength: number
  private readonly maxChunkChars: number

  constructor(config: CodeChunkerConfig) {
    this.language = config.language
    this.minChunkLength = config.minChunkLength ?? 50
    this.maxChunkChars = config.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS
  }

  async chunkText(text: string, _embedder: EmbedderInterface): Promise<TextChunk[]> {
    if (text.trim().length === 0) return []

    await ensureParserInit()
    const language = await loadLanguage(this.language)
    const parser = new Parser()
    parser.setLanguage(language)

    let segments: string[]
    try {
      const tree = parser.parse(text)
      segments = this.segmentNodes(text, tree.rootNode.namedChildren, boundaryFor(this.language))
    } finally {
      parser.delete()
    }

    // Fallback: a file with no recognizable top-level constructs (or a parse
    // that produced nothing) is still indexed — split it on line boundaries.
    if (segments.length === 0) {
      segments = this.splitLarge(text)
    }

    return this.finalizeChunks(segments)
  }

  /**
   * Walk a list of sibling nodes, producing one raw text segment per boundary
   * construct (with its leading comments) and merging runs of small non-boundary
   * statements (imports, fields, simple declarations) together.
   *
   * A boundary node that is a container (class/interface/enum/...) larger than
   * `maxChunkChars` is decomposed: its declaration header is prepended to the
   * first member chunk and each member is segmented recursively, giving
   * method-level granularity (essential for Java, where everything lives in a
   * class). Smaller containers are kept whole.
   */
  private segmentNodes(text: string, nodes: Parser.SyntaxNode[], boundary: Set<string>): string[] {
    const segments: string[] = []

    let commentStart: number | null = null // start of a contiguous leading-comment block
    let runStart: number | null = null // start of an accumulated non-boundary run
    let runEnd = -1

    const flushRun = () => {
      if (runStart !== null) {
        segments.push(text.slice(runStart, runEnd))
        runStart = null
        runEnd = -1
      }
    }

    for (const child of nodes) {
      const type = child.type

      if (COMMENT_TYPES.has(type)) {
        // A comment belongs to whatever follows it: close any non-boundary run
        // first, then start/extend the pending leading-comment block.
        flushRun()
        if (commentStart === null) commentStart = child.startIndex
        continue
      }

      if (boundary.has(type)) {
        flushRun()
        const start = commentStart ?? child.startIndex
        commentStart = null

        const body = getContainerBody(child)
        if (body && child.endIndex - start > this.maxChunkChars) {
          // Large container: header + per-member chunks.
          const header = text.slice(start, body.startIndex)
          const memberSegs = this.segmentNodes(text, body.namedChildren, boundary)
          if (memberSegs.length > 0) {
            memberSegs[0] = header + memberSegs[0]
            // Keep the container's closing delimiter with the last member.
            const lastMember = body.namedChildren[body.namedChildren.length - 1]
            if (lastMember) {
              memberSegs[memberSegs.length - 1] += text.slice(lastMember.endIndex, child.endIndex)
            }
            segments.push(...memberSegs)
          } else {
            segments.push(text.slice(start, child.endIndex))
          }
        } else {
          segments.push(text.slice(start, child.endIndex))
        }
        continue
      }

      // Non-boundary statement: merge into the current run, folding in any
      // pending leading comment as the run's start.
      if (commentStart !== null) {
        if (runStart === null) runStart = commentStart
        commentStart = null
      } else if (runStart === null) {
        runStart = child.startIndex
      }
      runEnd = child.endIndex
    }

    // Trailing leading-comment block with nothing after it: keep it as content.
    if (commentStart !== null) {
      segments.push(text.slice(commentStart))
    }
    flushRun()

    return segments
  }

  /**
   * Merge sub-`minChunkLength` segments into a neighbor, split oversized ones on
   * line boundaries, drop empties, and assign sequential indices.
   */
  private finalizeChunks(segments: string[]): TextChunk[] {
    // Merge tiny segments into the previous one (or the next, if first).
    const merged: string[] = []
    for (const seg of segments) {
      if (seg.trim().length === 0) continue
      if (seg.trim().length < this.minChunkLength && merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]}\n${seg}`
      } else {
        merged.push(seg)
      }
    }

    // Split oversized segments, then emit with sequential indices.
    const chunks: TextChunk[] = []
    for (const seg of merged) {
      for (const piece of this.splitLarge(seg)) {
        const trimmed = piece.trim()
        if (trimmed.length === 0) continue
        chunks.push({ text: trimmed, index: chunks.length })
      }
    }
    return chunks
  }

  /** Split text exceeding maxChunkChars into line-bounded windows. */
  private splitLarge(text: string): string[] {
    if (text.length <= this.maxChunkChars) return [text]
    const lines = text.split('\n')
    const out: string[] = []
    let buf: string[] = []
    let len = 0
    for (const line of lines) {
      if (len + line.length + 1 > this.maxChunkChars && buf.length > 0) {
        out.push(buf.join('\n'))
        buf = []
        len = 0
      }
      buf.push(line)
      len += line.length + 1
    }
    if (buf.length > 0) out.push(buf.join('\n'))
    return out
  }
}
