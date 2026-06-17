// CodeChunker tests. These load the real tree-sitter WASM grammars (cached at
// module scope, fast after the first parse) and assert that chunk boundaries
// land on AST constructs.

import { describe, expect, it } from 'vitest'
import { CodeChunker } from '../code-chunker.js'
import { selectChunker } from '../select-chunker.js'
import { SemanticChunker } from '../semantic-chunker.js'

// CodeChunker ignores the embedder; a no-op stub satisfies the interface.
const noopEmbedder = { embedBatch: async () => [] }

describe('CodeChunker (TypeScript)', () => {
  const ts = `import { z } from 'mod'
const A = 1

// leading comment for foo
export function foo(a) {
  return a + 1
}

class Bar {
  method() { return 2 }
}
`

  it('splits at function/class boundaries and attaches the leading comment', async () => {
    const chunker = new CodeChunker({ language: 'typescript' })
    const chunks = await chunker.chunkText(ts, noopEmbedder)
    const texts = chunks.map((c) => c.text)

    // foo is its own chunk and carries its preceding comment.
    const fooChunk = texts.find((t) => t.includes('function foo'))
    expect(fooChunk).toBeDefined()
    expect(fooChunk).toContain('// leading comment for foo')

    // Bar is a separate chunk.
    expect(texts.some((t) => t.includes('class Bar'))).toBe(true)
    // The import + const run merges (not split per statement).
    expect(texts.some((t) => t.includes('import { z }') && t.includes('const A'))).toBe(true)

    // Indices are sequential.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })
})

describe('CodeChunker (Python)', () => {
  const py = `import os

def hello(name):
    """greet"""
    return f"hi {name}"

class Thing:
    def m(self):
        return 1
`

  it('splits def and class definitions, keeping docstrings with their function', async () => {
    const chunker = new CodeChunker({ language: 'python' })
    const texts = (await chunker.chunkText(py, noopEmbedder)).map((c) => c.text)

    const helloChunk = texts.find((t) => t.includes('def hello'))
    expect(helloChunk).toBeDefined()
    expect(helloChunk).toContain('"""greet"""')
    expect(texts.some((t) => t.includes('class Thing'))).toBe(true)
  })
})

describe('CodeChunker (Java)', () => {
  it('splits a large class into per-method chunks', async () => {
    // Pad each method so the class exceeds maxChunkChars and triggers member split.
    const pad = '    // filler line to make the body large enough\n'.repeat(20)
    const java = `package com.x;
import java.util.List;

public class Foo {
  private int n;

  public int add(int a) {
${pad}    return a + n;
  }

  public int sub(int a) {
${pad}    return a - n;
  }
}
`
    const chunker = new CodeChunker({ language: 'java' })
    const texts = (await chunker.chunkText(java, noopEmbedder)).map((c) => c.text)

    // Each large method became its own chunk.
    expect(texts.some((t) => t.includes('public int add'))).toBe(true)
    expect(texts.some((t) => t.includes('public int sub'))).toBe(true)
    // add and sub are not lumped into one chunk.
    expect(texts.some((t) => t.includes('public int add') && t.includes('public int sub'))).toBe(
      false
    )
  })

  it('keeps a small class whole', async () => {
    const java = 'public class Small {\n  int x;\n  int get() { return x; }\n}\n'
    const chunker = new CodeChunker({ language: 'java' })
    const texts = (await chunker.chunkText(java, noopEmbedder)).map((c) => c.text)
    expect(texts.some((t) => t.includes('class Small') && t.includes('int get'))).toBe(true)
  })
})

describe('CodeChunker edge cases', () => {
  it('returns [] for empty input', async () => {
    const chunker = new CodeChunker({ language: 'typescript' })
    expect(await chunker.chunkText('   \n  ', noopEmbedder)).toEqual([])
  })

  it('splits an oversized construct on line boundaries', async () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i}`).join('\n')
    const big = `function huge() {\n${body}\n}\n`
    const chunker = new CodeChunker({ language: 'typescript', maxChunkChars: 500 })
    const chunks = await chunker.chunkText(big, noopEmbedder)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk wildly exceeds the cap (line-bounded, so some slack is expected).
    expect(chunks.every((c) => c.text.length <= 800)).toBe(true)
  })
})

describe('selectChunker', () => {
  it('returns a CodeChunker for code extensions', () => {
    for (const f of ['/a.ts', '/a.tsx', '/a.js', '/a.jsx', '/a.mjs', '/a.py', '/a.java']) {
      expect(selectChunker(f)).toBeInstanceOf(CodeChunker)
    }
  })

  it('returns a SemanticChunker for prose/other extensions', () => {
    for (const f of ['/a.md', '/a.txt', '/a.pdf', '/a.docx']) {
      expect(selectChunker(f)).toBeInstanceOf(SemanticChunker)
    }
  })
})
