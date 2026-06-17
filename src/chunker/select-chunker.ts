// Per-file chunker selection.
//
// Code files (by extension) get the AST-based CodeChunker; everything else
// (prose, PDFs, raw data) gets the SemanticChunker. Both honor `minChunkLength`.

import { extname } from 'node:path'
import { CodeChunker, codeLanguageForExtension } from './code-chunker.js'
import { SemanticChunker } from './semantic-chunker.js'
import type { Chunker } from './types.js'

export function selectChunker(
  filePath: string,
  options: { minChunkLength?: number } = {}
): Chunker {
  const language = codeLanguageForExtension(extname(filePath).toLowerCase())
  if (language) {
    return new CodeChunker(
      options.minChunkLength !== undefined
        ? { language, minChunkLength: options.minChunkLength }
        : { language }
    )
  }
  return new SemanticChunker(
    options.minChunkLength !== undefined ? { minChunkLength: options.minChunkLength } : {}
  )
}
