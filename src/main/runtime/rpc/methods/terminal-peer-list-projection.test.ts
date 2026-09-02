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

  // W-5..W-7 review F1 / Ruling 24(x): a fixture that CONTAINS visualLayouts and per-pane ids —
  // the field the un-fixed `{ ...result, terminals: … }` spread let through by default. The
  // review's own finding: the original fixture built only `terminals`, so the leak was invisible
  // to this suite.
  function setup(): void {
    runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [SAMPLE_TERMINAL],
      totalCount: 1,
      truncated: false,
      visualLayouts: [
        {
          worktreeId: 'wt_1',
          worktreePath: '/home/ubuntu/repo',
          root: {
            type: 'group',
            groupId: 'grp_1',
            activeTabId: 'tab_1',
            tabs: [
              {
                tabId: 'tab_1',
                title: 'Worker',
                activeLeafId: 'leaf_1',
                handle: 'term_x',
                panes: {
                  type: 'terminal',
                  handle: 'term_x',
                  tabId: 'tab_1',
                  leafId: 'leaf_1',
                  title: 'Worker',
                  connected: true,
                  active: true
                }
              }
            ]
          }
        }
      ],
      topologyRevisions: { wt_1: 7 }
    })
  }

  it('a peer caller sees only handle/worktreeId/title, other keys omitted not nulled', async () => {
    setup()
    const method = findMethod('terminal.list')
    const ctx: RpcContext = { runtime, accessProfile: 'peer' }
    const result = (await method.handler(
      method.params ? method.params.parse({}) : undefined,
      ctx
    )) as {
      terminals: Record<string, unknown>[]
      visualLayouts?: unknown
      topologyRevisions?: unknown
    }

    expect(result.terminals).toEqual([{ handle: 'term_x', worktreeId: 'wt_1', title: 'Worker' }])
    expect(Object.keys(result.terminals[0]!)).not.toContain('preview')
    expect(Object.keys(result.terminals[0]!)).not.toContain('worktreePath')
    expect(Object.keys(result.terminals[0]!).sort()).toEqual(['handle', 'title', 'worktreeId'])
    // W-5..W-7 review F1 / Ruling 24(x): visualLayouts/topologyRevisions must never survive the
    // peer projection — they carry worktreePath and every per-pane {handle,tabId,leafId} key,
    // which makeaPaneKey(tabId, stableLeafId) reconstructs into every pane key on the host.
    expect(result).not.toHaveProperty('visualLayouts')
    expect(result).not.toHaveProperty('topologyRevisions')
    expect(JSON.stringify(result)).not.toContain('leaf_1')
    expect(JSON.stringify(result)).not.toContain('tab_1')
    expect(JSON.stringify(result)).not.toContain('/home/ubuntu/repo')
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
