/**
 * §5's funnel coverage, one control per spawning RPC: the lane is derived host-side from the
 * caller's own grant. The other suites stub the resolver's *return value*, so they cannot see the
 * argument — these record it, and swapping in any other identity turns them red.
 */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcContext, RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'
import { SESSION_TAB_METHODS } from './session-tabs'
import { TERMINAL_METHODS } from './terminal'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function recordingLaneResolver(seen: (string | null | undefined)[]) {
  return {
    resolveCallerCredentialLane: (pairedDeviceId?: string | null) => {
      seen.push(pairedDeviceId)
      return { kind: 'shared' as const }
    }
  }
}

const callerContext = {
  clientKind: 'runtime' as const,
  pairedDeviceId: 'device-a',
  clientId: 'bearer-token'
}

describe('the lane each spawning RPC derives', () => {
  it('terminal.create asks for the caller’s grant, not its bearer token', async () => {
    const seen: (string | null | undefined)[] = []
    const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')
    if (!method) {
      throw new Error('terminal.create method missing')
    }

    await method.handler(
      { worktree: 'id:worktree-1', clientMutationId: 'mutation-1' },
      {
        runtime: {
          ...recordingLaneResolver(seen),
          createTerminal: vi.fn(async () => ({
            handle: 'terminal-1',
            worktreeId: 'worktree-1',
            title: null
          })),
          dedupeTerminalCreate: async (
            _clientIdentity: string,
            _worktree: string | undefined,
            _mutationId: string | undefined,
            _reconcileExisting: boolean,
            run: (worktree: string | undefined, handle: string | undefined) => Promise<unknown>
          ) => run('id:worktree-1', 'term_stable')
        },
        ...callerContext
      } as unknown as RpcContext,
      vi.fn()
    )

    expect(seen).toEqual(['device-a'])
  })

  it('session.tabs.createTerminal asks for the caller’s grant', async () => {
    const seen: (string | null | undefined)[] = []
    const runtime = {
      ...recordingLaneResolver(seen),
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Terminal',
          status: 'ready',
          terminal: 'pty-1',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.createTerminal', { worktree: 'id:wt-1', activate: true }),
      () => {},
      callerContext
    )

    expect(seen).toEqual(['device-a'])
  })

  it('worktree.create asks for the caller’s grant', async () => {
    const seen: (string | null | undefined)[] = []
    const runtime = {
      ...recordingLaneResolver(seen),
      getRuntimeId: () => 'test-runtime',
      dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
        run(),
      showRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git' as const,
        executionHostId: 'local' as const
      }),
      createManagedWorktree: vi.fn().mockResolvedValue({ worktree: { id: 'wt-1' } })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('worktree.create', { repo: 'repo-1', name: 'feature' }),
      () => {},
      callerContext
    )

    expect(seen).toEqual(['device-a'])
  })
})
