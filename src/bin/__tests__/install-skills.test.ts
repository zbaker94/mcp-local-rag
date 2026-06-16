// Unit tests for the skills installer CLI argument + target resolution logic.
// Test Type: Unit Test

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getTargetPath, type Options, parseArgs } from '../install-skills.js'

describe('install-skills', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    exitSpy.mockRestore()
    errSpy.mockRestore()
    delete process.env['CODEX_HOME']
  })

  describe('parseArgs', () => {
    it('defaults to project-level Claude Code with no args', () => {
      expect(parseArgs([])).toEqual({ target: 'claude-code-project', help: false })
    })

    it('parses --claude-code (project) and --claude-code --global', () => {
      expect(parseArgs(['--claude-code']).target).toBe('claude-code-project')
      expect(parseArgs(['--claude-code', '--global']).target).toBe('claude-code-global')
    })

    it('parses --codex variants (default global, --project, --global)', () => {
      expect(parseArgs(['--codex']).target).toBe('codex-global')
      expect(parseArgs(['--codex', '--project']).target).toBe('codex-project')
      expect(parseArgs(['--codex', '--global']).target).toBe('codex-global')
    })

    it('parses --path into a custom target', () => {
      expect(parseArgs(['--path', '/custom/dir'])).toEqual({
        target: 'custom',
        customPath: '/custom/dir',
        help: false,
      })
    })

    it.each([['--help'], ['-h']])('sets help for %s', (flag) => {
      expect(parseArgs([flag]).help).toBe(true)
    })

    it('exits when --path has no argument', () => {
      expect(() => parseArgs(['--path'])).toThrow('process.exit(1)')
    })

    it('exits on an unknown option', () => {
      expect(() => parseArgs(['--nope'])).toThrow('process.exit(1)')
    })

    it('ignores a non-flag positional argument', () => {
      expect(parseArgs(['stray']).target).toBe('claude-code-project')
    })
  })

  describe('getTargetPath', () => {
    const opts = (target: Options['target'], customPath?: string): Options => ({
      target,
      help: false,
      ...(customPath !== undefined ? { customPath } : {}),
    })

    it('resolves the claude-code project and global targets', () => {
      expect(getTargetPath(opts('claude-code-project'))).toBe('./.claude/skills/mcp-local-rag')
      expect(getTargetPath(opts('claude-code-global'))).toBe(
        join(homedir(), '.claude', 'skills', 'mcp-local-rag')
      )
    })

    it('resolves the codex project target', () => {
      expect(getTargetPath(opts('codex-project'))).toBe('./.codex/skills/mcp-local-rag')
    })

    it('honors CODEX_HOME for the codex global target', () => {
      process.env['CODEX_HOME'] = '/opt/codex'
      expect(getTargetPath(opts('codex-global'))).toBe('/opt/codex/skills/mcp-local-rag')
    })

    it('falls back to ~/.codex when CODEX_HOME is unset', () => {
      delete process.env['CODEX_HOME']
      expect(getTargetPath(opts('codex-global'))).toBe(
        join(homedir(), '.codex', 'skills', 'mcp-local-rag')
      )
    })

    it('resolves a custom path under an mcp-local-rag subdirectory', () => {
      expect(getTargetPath(opts('custom', '/my/skills'))).toBe(
        resolve('/my/skills', 'mcp-local-rag')
      )
    })

    it('exits when a custom target has no path', () => {
      expect(() => getTargetPath(opts('custom'))).toThrow('process.exit(1)')
    })
  })
})
