// Unit tests for the CLI subcommand dispatcher.
// Test Type: Unit Test

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runSkillsInstall: vi.fn(),
  runDelete: vi.fn(),
  runIngest: vi.fn(),
  runList: vi.fn(),
  runQuery: vi.fn(),
  runReadNeighbors: vi.fn(),
  runStatus: vi.fn(),
}))

vi.mock('../bin/install-skills.js', () => ({ run: mocks.runSkillsInstall }))
vi.mock('../cli/delete.js', () => ({ runDelete: mocks.runDelete }))
vi.mock('../cli/ingest.js', () => ({ runIngest: mocks.runIngest }))
vi.mock('../cli/list.js', () => ({ runList: mocks.runList }))
vi.mock('../cli/query.js', () => ({ runQuery: mocks.runQuery }))
vi.mock('../cli/read-neighbors.js', () => ({ runReadNeighbors: mocks.runReadNeighbors }))
vi.mock('../cli/status.js', () => ({ runStatus: mocks.runStatus }))

import { handleCli, SUBCOMMANDS } from '../cli-main.js'

describe('handleCli', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`)
    })
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('exposes the full set of supported subcommands', () => {
    expect(SUBCOMMANDS).toEqual([
      'skills',
      'ingest',
      'list',
      'query',
      'status',
      'delete',
      'read-neighbors',
    ])
  })

  it.each([
    ['ingest', () => mocks.runIngest],
    ['list', () => mocks.runList],
    ['query', () => mocks.runQuery],
    ['status', () => mocks.runStatus],
    ['delete', () => mocks.runDelete],
    ['read-neighbors', () => mocks.runReadNeighbors],
  ] as const)('routes "%s" to its runner with args + global options', async (sub, getRunner) => {
    const globalOptions = { dbPath: '/db' }
    await handleCli(sub, ['x', '--y'], globalOptions)

    expect(getRunner()).toHaveBeenCalledWith(['x', '--y'], globalOptions)
  })

  it('routes "skills install" to the installer (args after install) and exits 0', async () => {
    await expect(handleCli('skills', ['install', '--codex'])).rejects.toThrow('process.exit(0)')
    expect(mocks.runSkillsInstall).toHaveBeenCalledWith(['--codex'])
  })

  it('exits 1 for an unknown skills subcommand', async () => {
    await expect(handleCli('skills', ['frobnicate'])).rejects.toThrow('process.exit(1)')
    expect(mocks.runSkillsInstall).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown skills subcommand'))
  })
})
