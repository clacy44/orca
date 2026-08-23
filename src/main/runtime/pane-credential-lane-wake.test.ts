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

function createRuntime(paneLane: { worktreeId: string; principalId?: string } | null): {
  runtime: OrcaRuntimeService
  resumeSleepingAgents: ReturnType<typeof vi.fn>
} {
  const store = {
    getRepo: () => ({ id: 'repo-1', path: '/repo', displayName: 'repo' }),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => undefined,
    getWorkspaceSession: () => ({
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: { paneKey: PANE_KEY, worktreeId: WORKTREE, agent: 'claude' }
      }
    }),
    getPaneCredentialLanes: () => (paneLane ? { [PANE_KEY]: paneLane } : {})
  }
  const runtime = new OrcaRuntimeService(store as never)
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
  const resumeSleepingAgents = vi.fn()
  runtime.setNotifier({ resumeSleepingAgents } as never)
  return { runtime, resumeSleepingAgents }
}

describe('worktree.activate — the sleeping-agent wake', () => {
  it('leaves a lane-bound record asleep instead of waking it through the renderer', async () => {
    const { runtime, resumeSleepingAgents } = createRuntime({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false,
      pairedDeviceId: 'device-b'
    })

    expect(result.sleepingAgentWake).toBe('wake_refused_not_owned')
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
  })

  it('still wakes a record whose pane is on the shared lane', async () => {
    const { runtime, resumeSleepingAgents } = createRuntime({ worktreeId: WORKTREE })

    const result = await runtime.activateManagedWorktree(`id:${WORKTREE}`, {
      clientKind: 'mobile',
      notifyClients: false
    })

    expect(result.sleepingAgentWake).toBe('requested')
    expect(resumeSleepingAgents).toHaveBeenCalledWith(WORKTREE)
  })
})
