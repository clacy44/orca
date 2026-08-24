/**
 * The renderer wake does not reuse the slept pane — it mints a fresh one, which carries no lane and
 * therefore resolves to the shared `~/.claude`. A lane-bound record is never handed to it (§2a).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const WORKTREE = 'repo-1::wt-1'
const PANE_KEY = 'tab-1:leaf-1'

type InternalMethods = Record<string, (...args: never[]) => unknown>

function spyOnInternal(runtime: OrcaRuntimeService, name: string) {
  return vi.spyOn(runtime as unknown as InternalMethods, name)
}

const SHARED_PANE_KEY = 'tab-2:leaf-2'

function createRuntime(
  paneLane: { worktreeId: string; principalId?: string } | null,
  extraRecords: Record<string, unknown> = {}
): {
  runtime: OrcaRuntimeService
  resumeSleepingAgents: ReturnType<typeof vi.fn>
  ensureAgentSession: ReturnType<typeof vi.fn>
  remainingSleepingPaneKeys: () => string[]
} {
  let session = {
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        worktreeId: WORKTREE,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-1' }
      },
      ...extraRecords
    } as Record<string, unknown>
  }
  const store = {
    getRepo: () => ({ id: 'repo-1', path: '/repo', displayName: 'repo' }),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => undefined,
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: typeof session) => {
      session = next
    },
    getPaneCredentialLanes: () => (paneLane ? { [PANE_KEY]: paneLane } : {})
  }
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPrincipalLaneLookup({
    principalOf: (deviceId) => (deviceId === 'device-a' ? PRINCIPAL_A : null),
    linkPrincipalOf: () => null
  })
  spyOnInternal(runtime, 'assertGraphReady').mockReturnValue(undefined as never)
  spyOnInternal(runtime, 'resolveWorktreeSelector').mockResolvedValue({
    id: WORKTREE,
    repoId: 'repo-1',
    path: '/repo/wt-1'
  } as never)
  spyOnInternal(runtime, 'hydrateHeadlessMobileSessionTabsFromWorkspaceSession').mockReturnValue(
    undefined as never
  )
  spyOnInternal(runtime, 'refreshMobileSessionPtyRecords').mockResolvedValue(undefined as never)
  spyOnInternal(runtime, 'notifyMobileSessionTabsChanged').mockReturnValue(undefined as never)
  vi.spyOn(
    runtime as unknown as { getAvailableAuthoritativeWindow: () => unknown },
    'getAvailableAuthoritativeWindow'
  ).mockReturnValue({ webContents: { send: vi.fn(), isDestroyed: () => false } })
  spyOnInternal(runtime, 'flushWorkspaceSessionOrThrowAsync').mockResolvedValue(undefined as never)
  const ensureAgentSession = vi.fn().mockResolvedValue({ terminal: {}, disposition: 'created' })
  ;(runtime as unknown as Record<string, unknown>).ensureAgentSession = ensureAgentSession
  const resumeSleepingAgents = vi.fn()
  runtime.setNotifier({ resumeSleepingAgents } as never)
  return {
    runtime,
    resumeSleepingAgents,
    ensureAgentSession,
    remainingSleepingPaneKeys: () => Object.keys(session.sleepingAgentSessionsByPaneKey)
  }
}

describe('worktree.activate — the sleeping-agent wake', () => {
  it('leaves a lane-bound record asleep instead of waking it through the renderer', async () => {
    const { runtime } = createRuntime({ worktreeId: WORKTREE, principalId: PRINCIPAL_A })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false,
      pairedDeviceId: 'device-b'
    })

    expect(result.sleepingAgentWake).toBe('wake_refused_not_owned')
  })

  it('still asks for the wake so the shared-lane records beside it are not withheld too', async () => {
    const { runtime, resumeSleepingAgents } = createRuntime(
      { worktreeId: WORKTREE, principalId: PRINCIPAL_A },
      {
        [SHARED_PANE_KEY]: { paneKey: SHARED_PANE_KEY, worktreeId: WORKTREE, agent: 'claude' }
      }
    )

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false,
      pairedDeviceId: 'device-b'
    })

    // The host names the withheld panes on the wake itself; the shared-lane record beside them
    // still wakes, and the refusal reports the partition that actually happened.
    expect(result.sleepingAgentWake).toBe('wake_refused_not_owned')
    expect(resumeSleepingAgents).toHaveBeenCalledWith(WORKTREE, [PANE_KEY])
  })

  it('still wakes a record whose pane is on the shared lane', async () => {
    const { runtime, resumeSleepingAgents } = createRuntime({ worktreeId: WORKTREE })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false
    })

    expect(result.sleepingAgentWake).toBe('requested')
    expect(resumeSleepingAgents).toHaveBeenCalledWith(WORKTREE, [])
  })

  it("resumes the owner's own lane record through the host create path", async () => {
    const { runtime, ensureAgentSession, resumeSleepingAgents, remainingSleepingPaneKeys } =
      createRuntime({ worktreeId: WORKTREE, principalId: PRINCIPAL_A })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false,
      pairedDeviceId: 'device-a'
    })

    expect(result.sleepingAgentWake).toBe('requested')
    expect(ensureAgentSession).toHaveBeenCalledTimes(1)
    const [request, caller] = ensureAgentSession.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>
    ]
    // The host path is what resolves the lane, drops a peer's host-wide launch settings and binds
    // the minted paneKey before the spawn — so the request carries no settings-derived launch.
    expect(request).toMatchObject({ kind: 'explicit', agent: 'claude', presentation: 'background' })
    expect(request).not.toHaveProperty('agentArgs')
    expect(caller).toEqual({ pairedDeviceId: 'device-a' })
    // No second tab: the renderer is told to skip the pane the host just resumed, and the record
    // is consumed so a later renderer wake cannot mint an unbound pane for it.
    expect(resumeSleepingAgents).toHaveBeenCalledWith(WORKTREE, [PANE_KEY])
    expect(remainingSleepingPaneKeys()).not.toContain(PANE_KEY)
  })

  it("leaves the record asleep and unconsumed when another person's grant activates", async () => {
    const { runtime, ensureAgentSession, remainingSleepingPaneKeys } = createRuntime({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false,
      pairedDeviceId: 'device-b'
    })

    expect(result.sleepingAgentWake).toBe('wake_refused_not_owned')
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(remainingSleepingPaneKeys()).toContain(PANE_KEY)
  })

  // Negative control: having NO principal is not ownership.
  it('refuses an anonymous activate rather than treating no principal as a match', async () => {
    const { runtime, ensureAgentSession } = createRuntime({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false
    })

    expect(result.sleepingAgentWake).toBe('wake_refused_not_owned')
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })
})
