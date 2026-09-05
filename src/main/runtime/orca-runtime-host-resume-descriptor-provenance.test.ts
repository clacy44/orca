/**
 * [S10-21a C12b, D-R125] S-D — the forged host-resume descriptor. `restoreProvenance` is a
 * non-wire, in-process-only concept (D-R104 T44, Ruling 34 Addendum 15 — see
 * agent-launch-admission-schema-field-fence.test.ts): no zod schema names it, so a client-supplied
 * `restoreProvenance` is rejected outright by `.strict()`, never reaching `runtime.ensureAgentSession`.
 * Separately, `createTerminal`'s own E1 gate (orca-runtime.ts ~28272-28296) refuses an
 * UNKNOWN/unredeemed ticket and refuses a host-restore create that would take the renderer-backed
 * branch — both BEFORE any pty spawn or launch-session write. Real zod schema + real
 * `RpcDispatcher` (spy only on `runtime`); real `createTerminal` with a real `RestoreTicketRegistry`,
 * spy only on `ptyController.spawn`. GREEN at base — pins pre-existing fence behaviour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { RpcDispatcher } from './rpc/dispatcher'
import { AGENT_SESSION_METHODS } from './rpc/methods/agent-session'
import type { RpcRequest } from './rpc/core'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-sd'
const REPO_PATH = '/tmp/repo-sd'
const WORKTREE_PATH = '/tmp/worktree-sd'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const HOST_ID = 'local'
const TAB = 'tab-sd'
const LEAF = '99999999-9999-4999-8999-999999999999'

// [S-D (iii)] `getAvailableAuthoritativeWindow()` reads `BrowserWindow.fromId` — real `electron`
// resolves to a plain string outside an Electron process, so this returns null (background
// branch) unless mocked. Defaults to null (every OTHER subtest here needs no window); only the
// renderer-backed-branch subtest below points it at a live, non-destroyed window.
const electronMocks = vi.hoisted(() => ({ fromId: vi.fn((): unknown => null) }))
vi.mock('electron', () => ({
  BrowserWindow: { fromId: electronMocks.fromId },
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  { path: '/tmp/worktree-sd', head: 'abc', branch: 'main', isBare: false, isMainWorktree: false }
])
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  forceDeleteLocalBranch: vi.fn()
}))

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-sd-1', authToken: 'token', method, params }
}

function createSharedStore(): ConstructorParameters<typeof OrcaRuntimeService>[0] {
  const session: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 'sd-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'sd',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    }),
    getWorktreeMeta: (worktreeId: string): WorktreeMeta | undefined =>
      store.getAllWorktreeMeta()[worktreeId],
    setWorktreeMeta: () => undefined as never,
    removeWorktreeMeta: () => {},
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getWorkspaceSession: () => session,
    persistTerminalLaunchTokenHash: () => {},
    forgetTerminalLaunchTokenHash: () => {},
    isWritesFrozen: () => false
  }
  return store
}

function fakePtyController(): {
  spawn: ReturnType<typeof vi.fn>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
} {
  return {
    spawn: vi.fn().mockResolvedValue({ id: 'pty-sd-new' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
}

function launchSessionCount(db: OrchestrationDb, paneKey: string): number {
  const raw = (db as unknown as { db: Database.Database }).db
  const row = raw
    .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
    .get(paneKey) as { n: number }
  return row.n
}

describe('S10-21a C12b, D-R125 S-D: the forged host-resume descriptor', () => {
  let db: OrchestrationDb | null = null

  afterEach(() => {
    db?.close()
    db = null
    electronMocks.fromId.mockReset()
    electronMocks.fromId.mockReturnValue(null)
  })

  it("(i) a client-supplied restoreProvenance (or another non-wire field) on terminal.ensureAgentSession is rejected by the schema's .strict() — the runtime is never called", async () => {
    const ensureAgentSession = vi.fn()
    const runtime = { getRuntimeId: () => 'runtime-sd', ensureAgentSession }
    const dispatcher = new RpcDispatcher({
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_SESSION_METHODS
    })
    const validExplicitEnsure = {
      kind: 'explicit',
      worktree: `id:${WORKTREE_ID}`,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'provider-session-sd' },
      presentation: 'focused'
    }

    const withRestoreProvenance = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        ...validExplicitEnsure,
        restoreProvenance: { kind: 'host-restore', ticket: 't' }
      })
    )
    // A second, distinct non-wire field (D-R104 T44's other named in-process-only concept) —
    // the schema's `.strict()` must reject ANY unrecognized key, not merely this one name.
    const withLaunchAdmission = await dispatcher.dispatch(
      request('terminal.ensureAgentSession', {
        ...validExplicitEnsure,
        launchAdmission: { kind: 'covered' }
      })
    )

    expect(withRestoreProvenance).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(withLaunchAdmission).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })

  it('(ii) createTerminal refuses an unknown/unredeemed restore ticket — LaunchAdmissionRefusedError(restore_ticket_unknown), no spawn, no launch-session row', async () => {
    db = new OrchestrationDb(':memory:')
    const paneKey = makePaneKey(TAB, LEAF)
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(db)
    const controller = fakePtyController()
    runtime.setPtyController(
      controller as unknown as Parameters<typeof runtime.setPtyController>[0]
    )
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // A real RestoreTicketRegistry that NEVER minted this ticket — forged outright.
    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        restoreProvenance: { kind: 'host-restore', ticket: 'forged-ticket-never-minted' as never },
        credentialLane: { kind: 'shared' },
        tabId: TAB,
        leafId: LEAF
      })
    ).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'restore_ticket_unknown'
    })
    expect(controller.spawn).not.toHaveBeenCalled()
    expect(launchSessionCount(db, paneKey)).toBe(0)
  })

  it('(iii) a host-restore create that would take the renderer-backed branch is refused host_restore_requires_background, before ticket redemption', async () => {
    db = new OrchestrationDb(':memory:')
    const paneKey = makePaneKey(TAB, LEAF)
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(db)
    const controller = fakePtyController()
    runtime.setPtyController(
      controller as unknown as Parameters<typeof runtime.setPtyController>[0]
    )
    // An attached, LIVE authoritative window PLUS `presentation: 'focused'` forces
    // `shouldCreateInBackground` false — the renderer-backed branch this create would take.
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const internal = runtime as unknown as {
      restoreTickets: {
        mint: (payload: {
          predecessorPaneKey: string
          sessionId: string
          executionHostId: string
          launchGeneration: string
        }) => string
        peek: (id: string) => { ok: boolean; reason?: string }
      }
    }
    const ticket = internal.restoreTickets.mint({
      predecessorPaneKey: paneKey,
      sessionId: 'sess-sd',
      executionHostId: HOST_ID,
      launchGeneration: 'gen-sd'
    })

    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        restoreProvenance: { kind: 'host-restore', ticket: ticket as never },
        credentialLane: { kind: 'shared' },
        tabId: TAB,
        leafId: LEAF,
        presentation: 'focused'
      })
    ).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'host_restore_requires_background'
    })
    expect(controller.spawn).not.toHaveBeenCalled()
    // The ticket was never redeemed — the gate fires before redemption.
    expect(internal.restoreTickets.peek(ticket)).toMatchObject({ ok: true })
  })
})
