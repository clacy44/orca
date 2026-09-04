// S10-21a C3a-v2, errata 5(p) v2.1 §D (T27, T28, T43, T45, T45b, T46). The pane-key gate:
// `createTerminal`'s E1 (entry, unbypassable, before either branch and before the first
// await) and E2 (adopt-time, TOCTOU-closed, background-branch only). Every test here must
// fail at d3d743c9a6 (C3-v2c) — no gate exists there, `adoptStablePane` silently adopts, and
// `resolveAgentTerminalCreateOptions`'s equivalence is untested.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-gate'
const REPO_PATH = '/tmp/repo-gate'
const WORKTREE_PATH = '/tmp/worktree-gate'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const HOST_ID = 'local'

const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-gate',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
])
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  listWorktreesStrict: vi.fn().mockResolvedValue(MOCK_GIT_WORKTREES),
  assertWorktreeCleanForRemoval: vi.fn().mockResolvedValue(undefined),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  forceDeleteLocalBranch: vi.fn()
}))

const REGISTERED_TAB = 'tab-registered'
const OTHER_TAB = 'tab-other'
const LEAF_A = '77777777-7777-4777-8777-777777777777'
const LEAF_B = '88888888-8888-4888-8888-888888888888'
const NEW_PTY_ID = 'pty-gate-new-1'

function createSharedStore(): ConstructorParameters<typeof OrcaRuntimeService>[0] {
  const session: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 'gate-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'gate',
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
  spawn: (args: unknown) => Promise<{ id: string }>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
  spawnCallCount: () => number
} {
  let calls = 0
  return {
    spawn: async () => {
      calls += 1
      return { id: NEW_PTY_ID }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    spawnCallCount: () => calls
  }
}

function insertRegisteredAgent(db: OrchestrationDb, paneKey: string): void {
  const raw = (db as unknown as { db: Database.Database }).db
  raw
    .prepare(
      `INSERT INTO agents (
         id, display_name, host_id, pane_key, origin_kind, origin_pane_key, origin_host_id
       ) VALUES (?, ?, ?, ?, 'pane', ?, ?)`
    )
    .run(`agt_${paneKey}`, `disp-${paneKey}`, HOST_ID, paneKey, paneKey, HOST_ID)
}

function lastAuditRow(db: OrchestrationDb): { verb: string; outcome: string; reason_code: string } {
  const raw = (db as unknown as { db: Database.Database }).db
  return raw.prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`).get() as never
}

function launchSessionCount(db: OrchestrationDb, paneKey: string): number {
  const raw = (db as unknown as { db: Database.Database }).db
  const row = raw
    .prepare('SELECT COUNT(*) as n FROM agent_launch_sessions WHERE pane_key = ?')
    .get(paneKey) as { n: number }
  return row.n
}

describe('S10-21a C3a-v2, errata 5(p) v2.1 §D: the pane-key gate', () => {
  let db: OrchestrationDb | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  // T27: a local-socket create naming a registered non-tombstoned row's pane key is refused
  // pane_key_owned, audited, no launch row, no spawn — on BOTH presentations. The 'focused'
  // half is the F-4 fence: it never reaches `resolveTerminalWorkspaceLaunchScope` (E1 runs
  // before any branch), so it needs no worktree/pty machinery at all.
  it.each([
    ['background' as const, undefined],
    ['focused' as const, 'focused' as const]
  ])(
    'T27: a placement naming a registered pane is refused pane_key_owned (%s)',
    async (_label, presentation) => {
      db = new OrchestrationDb(':memory:')
      const paneKey = makePaneKey(REGISTERED_TAB, LEAF_A)
      insertRegisteredAgent(db, paneKey)
      const store = createSharedStore()
      const runtime = new OrcaRuntimeService(store)
      runtime.setOrchestrationDb(db)
      const controller = fakePtyController()
      runtime.setPtyController(controller)
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

      await expect(
        runtime.createTerminal(`path:${WORKTREE_PATH}`, {
          restoreProvenance: { kind: 'none' },
          credentialLane: { kind: 'shared' },
          tabId: REGISTERED_TAB,
          leafId: LEAF_A,
          ...(presentation ? { presentation } : {})
        })
      ).rejects.toMatchObject({
        name: 'LaunchAdmissionRefusedError',
        reasonCode: 'pane_key_owned'
      })

      const audited = lastAuditRow(db)
      expect(audited.verb).toBe('launch_refused')
      expect(audited.outcome).toBe('refused')
      expect(audited.reason_code).toBe('pane_key_owned')
      expect(launchSessionCount(db, paneKey)).toBe(0)
      expect(controller.spawnCallCount()).toBe(0)
    }
  )

  // T28: `createTerminal` refuses an occupied-leaf placement (a leaf a stable pane already
  // owns, per the controller's own notion — not only `this.leaves`) on the background branch,
  // where E2 runs. The refused leaf is registered under a DIFFERENT tab than the one this
  // create requests, matching clause A's leaf-suffix semantic.
  it('T28: createTerminal refuses an occupied leaf at adopt time (E2)', async () => {
    db = new OrchestrationDb(':memory:')
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(db)
    const controller = fakePtyController()
    runtime.setPtyController({
      ...controller,
      hasStablePaneForLeaf: (args: { leafId: string }) => args.leafId === LEAF_B,
      adoptStablePane: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        restoreProvenance: { kind: 'none' },
        credentialLane: { kind: 'shared' },
        tabId: OTHER_TAB,
        leafId: LEAF_B
      })
    ).rejects.toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'leaf_occupied'
    })
    expect(controller.spawnCallCount()).toBe(0)
  })

  // T43: [JUDGMENT CALL, see RETURN] a covered, placed launch with NO db ever attached in this
  // process is admitted at the gate — vacuously safe, since no db means no row was ever
  // registered to own this pane, never a silent skip of a real risk (see the doc comment on
  // `getOrchestrationDbForGate`). `launch_store_unavailable` for a covered launch that actually
  // needs the store is F-12's admission-level refusal (`agent-launch-admission.ts`), unchanged
  // by this commit — forcing that same throw out of THIS gate regressed ~100 pre-existing
  // runtime-suite tests that place a pane with no db ever attached. (b) a plain shell create
  // with no placement never touches getOrchestrationDb() either (F-H4).
  it('T43a: a covered, placed launch with no db ever attached is admitted at the gate (vacuously safe)', async () => {
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    // Deliberately no setOrchestrationDb().
    const controller = fakePtyController()
    runtime.setPtyController(controller)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' },
      launchAgent: 'claude',
      tabId: REGISTERED_TAB,
      leafId: LEAF_A
    })
    expect(terminal).toBeTruthy()
    expect(controller.spawnCallCount()).toBe(1)
  })

  it('T43b: a plain shell with no placement never opens the orchestration store', async () => {
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const controller = fakePtyController()
    runtime.setPtyController(controller)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const getDbSpy = vi.spyOn(runtime, 'getOrchestrationDb')

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' }
    })

    expect(terminal).toBeTruthy()
    expect(getDbSpy).not.toHaveBeenCalled()
    expect(controller.spawnCallCount()).toBe(1)
  })

  // T45 (F-13): the gate refuses a placement whose leafId matches a registered row's leaf
  // under a DIFFERENT tabId, and the sweep's own lookup (getAgentByPaneKey) resolves the same
  // row — proving gate and sweep never disagree. Both presentations are gated (E1 runs before
  // either branch).
  it.each([
    ['background' as const, undefined],
    ['focused' as const, 'focused' as const]
  ])(
    'T45: leaf-suffix match under a different tab is refused (%s)',
    async (_label, presentation) => {
      db = new OrchestrationDb(':memory:')
      const registeredPaneKey = makePaneKey(REGISTERED_TAB, LEAF_A)
      insertRegisteredAgent(db, registeredPaneKey)
      const requestedPaneKey = makePaneKey(OTHER_TAB, LEAF_A)
      // The sweep's own lookup resolves the SAME row for the requested (different-tab) key.
      expect(db.getAgentByPaneKey(HOST_ID, requestedPaneKey)?.pane_key).toBe(registeredPaneKey)

      const store = createSharedStore()
      const runtime = new OrcaRuntimeService(store)
      runtime.setOrchestrationDb(db)
      const controller = fakePtyController()
      runtime.setPtyController(controller)
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

      await expect(
        runtime.createTerminal(`path:${WORKTREE_PATH}`, {
          restoreProvenance: { kind: 'none' },
          credentialLane: { kind: 'shared' },
          tabId: OTHER_TAB,
          leafId: LEAF_A,
          ...(presentation ? { presentation } : {})
        })
      ).rejects.toMatchObject({ name: 'LaunchAdmissionRefusedError', reasonCode: 'pane_key_owned' })
      expect(controller.spawnCallCount()).toBe(0)
    }
  )

  // T45b (F-L2): `resolveAgentTerminalCreateOptions`'s three early returns and its spread
  // return all leave tabId/leafId byte-identical to the input opts — the reason E1 (reading
  // opts.*) and E2 (reading launchOpts.*) are the same question asked twice.
  it('T45b: resolveAgentTerminalCreateOptions never rewrites tabId/leafId, on every return path', async () => {
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const internal = runtime as unknown as {
      resolveAgentTerminalCreateOptions: (
        workspace: unknown,
        opts: Record<string, unknown>,
        lane: unknown
      ) => Promise<{ tabId?: string; leafId?: string }>
    }
    const workspace = { id: WORKTREE_ID, path: WORKTREE_PATH, connectionId: null, repo: undefined }
    const lane = { kind: 'shared' }
    const base = { tabId: REGISTERED_TAB, leafId: LEAF_A }

    // Path 1 (~:27330 area): callerSuppliedLaunch true (opts.env set), no workspace.repo needed.
    const p1 = await internal.resolveAgentTerminalCreateOptions(
      workspace,
      { ...base, env: {} },
      lane
    )
    expect(p1.tabId).toBe(base.tabId)
    expect(p1.leafId).toBe(base.leafId)

    // Path 2 (~:27353): !workspace.repo, no caller-supplied launch, opts.command set.
    const p2 = await internal.resolveAgentTerminalCreateOptions(
      workspace,
      { ...base, command: 'bash -lc "echo hi"' },
      lane
    )
    expect(p2.tabId).toBe(base.tabId)
    expect(p2.leafId).toBe(base.leafId)

    // Path 3 (!opts.command, no caller-supplied launch): same early return.
    const p3 = await internal.resolveAgentTerminalCreateOptions(workspace, { ...base }, lane)
    expect(p3.tabId).toBe(base.tabId)
    expect(p3.leafId).toBe(base.leafId)
  })

  // T46 (§E): a renderer-backed create with a placement sends no tabId/leafId on
  // `terminal:requestTabCreate` — the minted pane is never the placement's — which is exactly
  // why E1 has to refuse it up front rather than letting it silently ignore the placement.
  // Paired with T27's 'focused' refusal half above (η): a 'focused' create with a registered
  // placement never reaches the renderer IPC send at all.
  it('T46: a focused create with a registered placement never reaches the renderer IPC send', async () => {
    db = new OrchestrationDb(':memory:')
    const paneKey = makePaneKey(REGISTERED_TAB, LEAF_A)
    insertRegisteredAgent(db, paneKey)
    const store = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(db)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const internal = runtime as unknown as { assertGraphReady: () => void }
    const graphReadySpy = vi.spyOn(internal, 'assertGraphReady')

    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        restoreProvenance: { kind: 'none' },
        credentialLane: { kind: 'shared' },
        tabId: REGISTERED_TAB,
        leafId: LEAF_A,
        presentation: 'focused'
      })
    ).rejects.toMatchObject({ name: 'LaunchAdmissionRefusedError', reasonCode: 'pane_key_owned' })
    // assertGraphReady is the renderer-backed branch's own first statement (after E1) — never
    // reached because E1 refused before the branch split.
    expect(graphReadySpy).not.toHaveBeenCalled()
  })
})
