/**
 * The renderer wake mints a fresh, unbound tab, which resolves to the shared `~/.claude`. A record
 * whose pane is bound to a person's credential lane is therefore never woken by it — it stays
 * asleep and uncleared for the host create path (S9 §2a, §3's degradation row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { stampSleepingAgentSessionLanes } from './sleeping-agent-session-lane'

const mockCreateTab = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockClearSleepingAgentSession = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {} as Record<string, string>,
    agentDefaultArgs: {} as Record<string, string>,
    agentDefaultEnv: {} as Record<string, Record<string, string>>,
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [{ id: 'repo-1', connectionId: null as string | null, path: '/repo' }],
  worktreesByRepo: {
    'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/feature', displayName: 'feature' }]
  },
  getKnownWorktreeById: (id: string) =>
    Object.values(store.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === id),
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: mockCreateTab,
  queueTabStartupCommand: mockQueueTabStartupCommand,
  claimAutomaticAgentResume: vi.fn(),
  clearSleepingAgentSession: mockClearSleepingAgentSession,
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'linux' }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: vi.fn((_stored, termIds: string[]) => [...termIds])
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = 'tab-1:leaf-1'

const record: SleepingAgentSessionRecord = {
  paneKey: PANE_KEY,
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: '0199f7a1-0000-7000-8000-000000000001' },
  prompt: 'finish the task',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}

async function launch(target: SleepingAgentSessionRecord): Promise<boolean> {
  const { launchSleepingAgentSession } = await import('./sleeping-agent-session-launch')
  return launchSleepingAgentSession(target)
}

describe('launchSleepingAgentSession — lane-bound records', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateTab.mockReturnValue({ id: 'tab-9' })
  })

  it('refuses to wake a lane-bound record, and leaves it asleep', async () => {
    expect(await launch({ ...record, lanePrincipalId: PRINCIPAL_A })).toBe(false)

    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockQueueTabStartupCommand).not.toHaveBeenCalled()
    expect(mockClearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('wakes a record with no lane exactly as before', async () => {
    expect(await launch(record)).toBe(true)

    expect(mockCreateTab).toHaveBeenCalledTimes(1)
    expect(mockClearSleepingAgentSession).toHaveBeenCalledWith(PANE_KEY)
  })
})

describe('stampSleepingAgentSessionLanes', () => {
  it('carries the host’s pane row onto the record the wake reads', () => {
    const stamped = stampSleepingAgentSessionLanes(
      { [PANE_KEY]: record },
      { [PANE_KEY]: { worktreeId: 'wt-1', principalId: PRINCIPAL_A } }
    )

    expect(stamped[PANE_KEY]?.lanePrincipalId).toBe(PRINCIPAL_A)
  })

  it('leaves an explicitly shared row unstamped, so it still wakes', () => {
    const stamped = stampSleepingAgentSessionLanes(
      { [PANE_KEY]: record },
      { [PANE_KEY]: { worktreeId: 'wt-1' } }
    )

    expect(stamped[PANE_KEY]?.lanePrincipalId).toBeUndefined()
    expect(stamped[PANE_KEY]).toBe(record)
  })
})
