/**
 * The funnel binds the lane to the pane it mints, and reads it back by pane identity (S9 §2a).
 * These drive `createTerminal` itself rather than the predicate, because the point of rev 8 is
 * that no launch input — and no presentation flag — can steer which lane a pane runs on.
 */
import { describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { OrcaRuntimeService } from './orca-runtime'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'

const principals: PrincipalLookup = {
  principalOf: (deviceId) =>
    deviceId === 'device-a' ? PRINCIPAL_A : deviceId === 'device-b' ? PRINCIPAL_B : null,
  linkPrincipalOf: () => null
}

function stubLaunchScope(runtime: OrcaRuntimeService, worktreeId = 'wt-1'): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: worktreeId,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

function createRuntime(): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  stubLaunchScope(runtime)
  runtime.setPrincipalLaneLookup(principals)
  const spawn = vi.fn().mockImplementation(async (args: { tabId?: string; leafId?: string }) => ({
    id: `pty-${args.tabId}-${args.leafId}`
  }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

async function refusalCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no-refusal'
}

describe('createTerminal funnel — lane binding', () => {
  it('binds a lane caller’s pane to that caller’s lane', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup('wt-1', tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })

  it('resolves an anonymous caller and a grant bound to no principal to the shared lane', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-unbound')
    })
    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane(undefined)
    })

    for (const call of spawn.mock.calls) {
      expect(runtime.paneCredentialLaneLookup('wt-1', call[0].tabId, call[0].leafId)).toEqual({
        kind: 'bound',
        lane: { kind: 'shared' }
      })
    }
  })

  it('throws for a caller supplying neither a lane nor an explicit shared', async () => {
    const { runtime, spawn } = createRuntime()

    expect(
      await refusalCodeOf(() =>
        runtime.createTerminal('id:wt-1', { restoreProvenance: { kind: 'none' } } as unknown as {
          credentialLane: { kind: 'shared' }
          restoreProvenance: { kind: 'none' }
        })
      )
    ).toBe('terminal.lane_unspecified')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a lane create with no workspace selector', async () => {
    const { runtime, spawn } = createRuntime()

    expect(
      await refusalCodeOf(() =>
        runtime.createTerminal(undefined, {
          restoreProvenance: { kind: 'none' },
          credentialLane: { kind: 'principal', principalId: PRINCIPAL_A }
        })
      )
    ).toBe('terminal.lane_requires_workspace')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('serves a lane create on the background branch even with focus and rendererBacked set', async () => {
    const { runtime, spawn } = createRuntime()
    const send = vi.fn()
    vi.spyOn(
      runtime as unknown as { getAvailableAuthoritativeWindow: () => unknown },
      'getAvailableAuthoritativeWindow'
    ).mockReturnValue({ webContents: { send, isDestroyed: () => false } })

    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'principal', principalId: PRINCIPAL_A },
      focus: true,
      rendererBacked: true,
      presentation: 'focused'
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup('wt-1', tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })
})

describe('createTerminal funnel — the adopt gate', () => {
  async function boundPane(): Promise<{
    runtime: OrcaRuntimeService
    spawn: ReturnType<typeof vi.fn>
    tabId: string
    leafId: string
  }> {
    const { runtime, spawn } = createRuntime()
    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })
    const { tabId, leafId } = spawn.mock.calls[0][0]
    spawn.mockClear()
    return { runtime, spawn, tabId, leafId }
  }

  it('refuses a hinted pane identity bound to another lane', async () => {
    const { runtime, spawn, tabId, leafId } = await boundPane()

    expect(
      await refusalCodeOf(() =>
        runtime.createTerminal('id:wt-1', {
          restoreProvenance: { kind: 'none' },
          credentialLane: runtime.resolveCallerCredentialLane('device-b'),
          tabId,
          leafId
        })
      )
    ).toBe('terminal.lane_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a lane-less shared caller adopting a lane-bound pane', async () => {
    const { runtime, spawn, tabId, leafId } = await boundPane()

    expect(
      await refusalCodeOf(() =>
        runtime.createTerminal('id:wt-1', {
          restoreProvenance: { kind: 'none' },
          credentialLane: { kind: 'shared' },
          tabId,
          leafId
        })
      )
    ).toBe('terminal.lane_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('leaves the binding row untouched when an adopt is refused', async () => {
    const { runtime, tabId, leafId } = await boundPane()

    await refusalCodeOf(() =>
      runtime.createTerminal('id:wt-1', {
        restoreProvenance: { kind: 'none' },
        credentialLane: { kind: 'shared' },
        tabId,
        leafId
      })
    )

    expect(runtime.paneCredentialLaneLookup('wt-1', tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })

  it('respawns into a bound paneKey on the pane’s own lane, for its owner', async () => {
    const { runtime, spawn, tabId, leafId } = await boundPane()

    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a'),
      tabId,
      leafId
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(runtime.paneCredentialLaneLookup('wt-1', tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })
})

describe('createTerminal funnel — a pane the host knows but never attributed', () => {
  const UNBOUND_TAB = 'legacy-tab'
  const UNBOUND_LEAF = '44444444-4444-4444-8444-444444444444'

  function runtimeWithKnownUnboundPane(): {
    runtime: OrcaRuntimeService
    spawn: ReturnType<typeof vi.fn>
  } {
    const { runtime, spawn } = createRuntime()
    vi.spyOn(
      runtime as unknown as { getWorkspaceSessionForWorktree: (id: string) => unknown },
      'getWorkspaceSessionForWorktree'
    ).mockReturnValue({
      terminalPtyIncarnationsByPaneKey: { [`${UNBOUND_TAB}:${UNBOUND_LEAF}`]: 'inc-1' }
    })
    return { runtime, spawn }
  }

  it('reads it as unbound rather than unknown', () => {
    const { runtime } = runtimeWithKnownUnboundPane()

    expect(runtime.paneCredentialLaneLookup('wt-1', UNBOUND_TAB, UNBOUND_LEAF)).toEqual({
      kind: 'unbound'
    })
  })

  it('leaves it unattributed when a lane-less caller reopens it, end to end', async () => {
    const { runtime } = runtimeWithKnownUnboundPane()

    await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' },
      tabId: UNBOUND_TAB,
      leafId: UNBOUND_LEAF
    })

    // §2h: the pane renders `unknown`, never attributed to a person — and a lane holder is still
    // refused, with the refusal that names the real state.
    expect(runtime.paneCredentialLaneLookup('wt-1', UNBOUND_TAB, UNBOUND_LEAF)).toEqual({
      kind: 'unbound'
    })
    expect(
      await refusalCodeOf(() =>
        runtime.createTerminal('id:wt-1', {
          restoreProvenance: { kind: 'none' },
          credentialLane: runtime.resolveCallerCredentialLane('device-a'),
          tabId: UNBOUND_TAB,
          leafId: UNBOUND_LEAF
        })
      )
    ).toBe('terminal.lane_pane_unbound')
  })
})

describe('splitPtyBackedTerminal — the ownership predicate', () => {
  it('refuses grant B splitting grant A’s lane pane, and spawns nothing', async () => {
    const { runtime, spawn } = createRuntime()
    const created = await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })
    spawn.mockClear()

    expect(
      await refusalCodeOf(() =>
        runtime.splitTerminal(created.handle, { pairedDeviceId: 'device-b' })
      )
    ).toBe('terminal.lane_not_owned')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lets the pane’s own principal split it, and binds the new pane to the same lane', async () => {
    const { runtime, spawn } = createRuntime()
    const created = await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })
    spawn.mockClear()

    await runtime.splitTerminal(created.handle, { pairedDeviceId: 'device-a' })

    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup('wt-1', tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
  })

  it('stamps the split pane’s own lane onto its pty record, not the funnel’s only', async () => {
    const { runtime, spawn } = createRuntime()
    const created = await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })
    spawn.mockClear()

    await runtime.splitTerminal(created.handle, { pairedDeviceId: 'device-a' })

    // Why: the record and the binding row must agree on every edge, not only in the funnel —
    // a record left null there mis-resolves once the spawn anchor reads it (§2h).
    const { tabId, leafId } = spawn.mock.calls[0][0]
    const record = (
      runtime as unknown as { ptysById: Map<string, { lanePrincipalId?: string | null }> }
    ).ptysById.get(`pty-${tabId}-${leafId}`)
    expect(record?.lanePrincipalId).toBe(PRINCIPAL_A)
  })

  it('carries the caller into the split from agentTeams.tmuxCompat, the second door into it', async () => {
    const { runtime } = createRuntime()
    const splitTerminal = vi.spyOn(runtime, 'splitTerminal').mockResolvedValue({
      handle: 'term-split'
    } as never)
    // Why: the predicate lives in `splitPtyBackedTerminal`, so what this door owes it is the
    // caller — the `terminal.split` handler is not on this path at all (§2a).
    ;(
      runtime as unknown as {
        claudeAgentTeams: {
          handleTmuxCompat: (
            request: unknown,
            api: { splitTerminal: (handle: string, opts: object) => Promise<unknown> }
          ) => Promise<unknown>
        }
      }
    ).claudeAgentTeams = {
      handleTmuxCompat: async (_request, api) => api.splitTerminal('term-parent', {})
    }

    await runtime.handleAgentTeamsTmuxCompat({ envPane: 'pane' } as never, {
      pairedDeviceId: 'device-b'
    })

    expect(splitTerminal).toHaveBeenCalledWith(
      'term-parent',
      expect.objectContaining({ pairedDeviceId: 'device-b' })
    )
  })

  it('refuses a worker-start inherit from another principal’s pane', async () => {
    const { runtime } = createRuntime()
    const created = await runtime.createTerminal('id:wt-1', {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    expect(
      await refusalCodeOf(async () =>
        runtime.resolveInheritedCredentialLaneForHandle(created.handle, {
          pairedDeviceId: 'device-b'
        })
      )
    ).toBe('terminal.lane_not_owned')
    expect(
      runtime.resolveInheritedCredentialLaneForHandle(created.handle, {
        pairedDeviceId: 'device-a'
      })
    ).toEqual({ kind: 'principal', principalId: PRINCIPAL_A })
  })
})

describe('federated creates', () => {
  it('fails closed when the link carries no principal binding', async () => {
    const { runtime } = createRuntime()
    // (createRuntime installs a principal lookup, which is what arms the refusal.)

    expect(
      await refusalCodeOf(async () => runtime.resolveFederatedLinkCredentialLane('fingerprint-x'))
    ).toBe('terminal.lane_link_unbound')
  })

  it('binds the link’s principal — never a grant — when the link is bound', async () => {
    const { runtime } = createRuntime()
    runtime.setPrincipalLaneLookup({
      principalOf: () => null,
      linkPrincipalOf: (fingerprint) => (fingerprint === 'fingerprint-x' ? PRINCIPAL_B : null)
    })

    expect(runtime.resolveFederatedLinkCredentialLane('fingerprint-x')).toEqual({
      kind: 'principal',
      principalId: PRINCIPAL_B
    })
  })
})
