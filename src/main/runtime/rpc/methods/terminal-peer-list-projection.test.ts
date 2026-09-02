// S10-19 W-5 (§5, F6): terminal.list's peer-profile projection — a federation-peer grant sees
// only handle/worktreeId/title, keys omitted (not nulled).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_METHODS } from './terminal'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext, RpcMethod } from '../core'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'

function findMethod(name: string): RpcMethod {
  const method = TERMINAL_METHODS.find((m) => m.name === name)
  if (!method || 'stream' in method) {
    throw new Error(`method not found: ${name}`)
  }
  return method
}

const SAMPLE_TERMINAL: RuntimeTerminalSummary = {
  handle: 'term_x',
  ptyId: 'pty_1',
  worktreeId: 'wt_1',
  worktreePath: '/home/ubuntu/repo',
  branch: 'main',
  tabId: 'tab_1',
  leafId: 'leaf_1',
  title: 'Worker',
  connected: true,
  writable: true,
  lastOutputAt: null,
  preview: 'some secret preview text'
}

describe('S10-19 W-5: terminal.list peer projection', () => {
  let runtime: OrcaRuntimeService
  afterEach(() => vi.restoreAllMocks())

  function setup(): void {
    runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [SAMPLE_TERMINAL],
      totalCount: 1,
      truncated: false
    })
  }

  it('a peer caller sees only handle/worktreeId/title, other keys omitted not nulled', async () => {
    setup()
    const method = findMethod('terminal.list')
    const ctx: RpcContext = { runtime, accessProfile: 'peer' }
    const result = (await method.handler(
      method.params ? method.params.parse({}) : undefined,
      ctx
    )) as { terminals: Record<string, unknown>[] }

    expect(result.terminals).toEqual([{ handle: 'term_x', worktreeId: 'wt_1', title: 'Worker' }])
    expect(Object.keys(result.terminals[0]!)).not.toContain('preview')
    expect(Object.keys(result.terminals[0]!)).not.toContain('worktreePath')
    expect(Object.keys(result.terminals[0]!).sort()).toEqual(['handle', 'title', 'worktreeId'])
  })

  it('a full-profile caller sees the unprojected shape', async () => {
    setup()
    const method = findMethod('terminal.list')
    const ctx: RpcContext = { runtime, accessProfile: 'full' }
    const result = (await method.handler(
      method.params ? method.params.parse({}) : undefined,
      ctx
    )) as { terminals: Record<string, unknown>[] }

    expect(result.terminals[0]).toMatchObject({ preview: 'some secret preview text' })
  })

  it('an undefined accessProfile (local caller) sees the unprojected shape', async () => {
    setup()
    const method = findMethod('terminal.list')
    const ctx: RpcContext = { runtime }
    const result = (await method.handler(
      method.params ? method.params.parse({}) : undefined,
      ctx
    )) as { terminals: Record<string, unknown>[] }

    expect(result.terminals[0]).toMatchObject({ preview: 'some secret preview text' })
  })
})
