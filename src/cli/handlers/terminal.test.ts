import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'

describe('terminal list CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('requests visualLayouts identically for --json and text (BUG 1)', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { terminals: [], visualLayouts: [], truncated: false, totalCount: 0 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal list']({
      flags: new Map(),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal list']({
      flags: new Map(),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(call).toHaveBeenNthCalledWith(
      1,
      'terminal.list',
      expect.objectContaining({
        includeVisualLayouts: true
      })
    )
    expect(call).toHaveBeenNthCalledWith(
      2,
      'terminal.list',
      expect.objectContaining({
        includeVisualLayouts: true
      })
    )
  })
})

describe('terminal set-role CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends --text as the role, and null when omitted (BUG 2)', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { setRole: { handle: 'term-1', role: 'merge-restructure backend' } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal set-role']({
      flags: new Map([
        ['terminal', 'term-1'],
        ['text', 'merge-restructure backend']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.setRole', {
      terminal: 'term-1',
      role: 'merge-restructure backend'
    })
  })

  it('clears the role when --text is omitted', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { setRole: { handle: 'term-1', role: null } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal set-role']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.setRole', { terminal: 'term-1', role: null })
  })
})

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the default close RPC unchanged', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
    const parsed = parseArgs(['terminal', 'close', '--terminal', 'term-1', '--tab'])
    const call = vi.fn().mockResolvedValue({
      result: {
        close: {
          handle: 'term-1',
          tabId: 'tab-1',
          closeMode: 'tab',
          ptyKilled: false
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(parsed.flags.get('tab')).toBe(true)
    expect(call).toHaveBeenCalledWith('terminal.closeTab', { terminal: 'term-1' })
  })

  it('documents that --tab waits for durable persistence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'close'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('orca terminal close [--terminal <handle>] [--tab] [--json]')
    expect(help).toContain('durable persistence')
  })
})
