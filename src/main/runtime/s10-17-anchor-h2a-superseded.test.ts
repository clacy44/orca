// H2a (F-6d, Ruling 32 Addendum 4): split out of s10-17-attestation-anchor.test.ts (800-line
// test-file cap) — these four tests replace ones from that file whose original premise (F8:
// never abort the launch on an anchor-flush failure, queue and retry later) is superseded by
// H2a's persist-before-spawn ruling: the anchor is now written BEFORE spawn and a flush
// failure aborts the launch outright, so no token-bearing process is ever left unanchored.
// See that file for the untouched S10-17 tests (anchor-clobber, replayed/cloned token,
// adopted-no-token, no-token-reveal, F4, F5, F5 caveat).
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-s10-17'
const REPO_PATH = '/tmp/repo-s10-17'
const WORKTREE_PATH = '/tmp/worktree-s10-17'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): mirrors s10-17-attestation-anchor.test.ts.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-s10-17',
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

const TAB_ID = 'tab-s10-17'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const TAB_ID_2 = 'tab-s10-17-second'
const LEAF_ID_2 = '33333333-3333-4333-8333-333333333333'
const PANE_KEY_2 = makePaneKey(TAB_ID_2, LEAF_ID_2)
const TAB_ID_3 = 'tab-s10-17-third'
const LEAF_ID_3 = '44444444-4444-4444-8444-444444444444'
const PANE_KEY_3 = makePaneKey(TAB_ID_3, LEAF_ID_3)
const TAB_ID_4 = 'tab-s10-17-fourth'
const LEAF_ID_4 = '55555555-5555-4555-8555-555555555555'
const PTY_ID = 'pty-s10-17-1'

// Why real semantics matter: faking the storage medium is fine, faking
// persistTerminalLaunchTokenHash's/flush's behavior would defeat the test.
function createSharedStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  sessionSnapshot: () => WorkspaceSessionState
  setFlushFailuresRemaining: (n: number) => void
  setWritesFrozen: (frozen: boolean) => void
} {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalLaunchTokenHashesByPaneKey: {}
  }
  let flushFailuresRemaining = 0
  let writesFrozen = false
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 's10-17-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 's10-17',
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
    persistTerminalLaunchTokenHash: (args: {
      tabId: string
      leafId: string
      launchTokenHash: string
    }) => {
      if (flushFailuresRemaining > 0) {
        flushFailuresRemaining -= 1
        throw new Error('simulated flush failure')
      }
      if (writesFrozen) {
        return
      }
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [makePaneKey(args.tabId, args.leafId)]: args.launchTokenHash
      }
    },
    forgetTerminalLaunchTokenHash: (paneKey: string) => {
      const { [paneKey]: _removed, ...rest } = session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = rest
    },
    isWritesFrozen: () => writesFrozen
  }
  return {
    store,
    sessionSnapshot: () => session,
    setFlushFailuresRemaining: (n: number) => {
      flushFailuresRemaining = n
    },
    setWritesFrozen: (frozen: boolean) => {
      writesFrozen = frozen
    }
  }
}

/** Plain (non-adopting) fake pty controller — every spawn is a fresh mint. */
function fakePtyController(onSpawn: (env: Record<string, string> | undefined) => void): {
  spawn: (args: { env?: Record<string, string> }) => Promise<{ id: string }>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
} {
  return {
    spawn: async (args) => {
      onSpawn(args.env)
      return { id: PTY_ID }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
}

describe('H2a (F-6d, Ruling 32 Addendum 4): S10-17 tests superseded by persist-before-spawn', () => {
  // H2a (F-6d, Ruling 32 Addendum 4) supersedes this test's original premise: the anchor is
  // now persisted BEFORE spawn and a flush failure aborts the launch outright (never a queued
  // retry that lets a token-bearing process start unanchored) — closing the exact corner F-6d
  // exploited. Rewritten to assert the new behavior; the retry-queue/drain mechanism this test
  // used to exercise no longer participates in createTerminal's own mint path (see F1/F2 below).
  it('H2a: a failed anchor flush aborts the launch before spawn — no unanchored token-bearing process', async () => {
    const { store, sessionSnapshot, setFlushFailuresRemaining } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let spawnCalled = false
    runtime.setPtyController(
      fakePtyController(() => {
        spawnCalled = true
      })
    )
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    setFlushFailuresRemaining(1)
    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        credentialLane: { kind: 'shared' },
        command: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        tabId: TAB_ID,
        leafId: LEAF_ID,
        title: 'agent-t1'
      })
    ).rejects.toThrow('launch_token_anchor_unavailable')
    // The spawn must never have been reached — no process ever held an unanchored token.
    expect(spawnCalled).toBe(false)
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // A second, unrelated launch with a healthy store succeeds normally and anchors immediately.
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'agent-t2'
    })
    const token2 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token2).toBeTruthy()
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY_2]).toBe(
      createHash('sha256').update(token2!).digest('hex')
    )
  })

  // H2a (F-6d, Ruling 32 Addendum 4) supersedes this test's original premise: createTerminal's
  // own mint no longer queues a retry on flush failure (it aborts the launch — see the H2a
  // test above), so there is nothing left to "queue" here. Both cases now mint normally
  // (anchor written synchronously by step 1) and only exercise the two forget sites.
  it('F1: forgetting an anchor at both forget sites is not resurrected by an unrelated later mint', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let spawnCount = 0
    runtime.setPtyController({
      spawn: async () => {
        spawnCount += 1
        return { id: `pty-f1-${spawnCount}` }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // --- Case 1: the S10-10/F1 retire lever (orca-runtime.ts ~:13497). ---
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    // Anchored synchronously by step 1, before spawn.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeTruthy()
    // command-finished fires the retire lever, which forgets pane P's anchor.
    runtime.emitDaemonPtyTransientFact('pty-f1-1', { kind: 'command-finished', exitCode: 0 })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // An unrelated successful anchor persist must not resurrect P's retired anchor.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'agent-t2'
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // --- Case 2: the F4 plain-shell relaunch forget (orca-runtime.ts ~:27517). ---
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_3,
      leafId: LEAF_ID_3,
      title: 'agent-t3'
    })
    // Anchored synchronously by step 1, before spawn.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY_3]).toBeTruthy()
    // Relaunch the same pane as a plain shell (no launchConfig) — the forget branch fires.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'bash',
      tabId: TAB_ID_3,
      leafId: LEAF_ID_3,
      title: 'plain-shell'
    })

    // Another unrelated successful anchor persist must not resurrect P3's forgotten anchor.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_4,
      leafId: LEAF_ID_4,
      title: 'agent-t4'
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY_3]).toBeUndefined()
  })

  // H2a (F-6d, Ruling 32 Addendum 4) supersedes this test's original premise: createTerminal's
  // own mint no longer queues anything on flush failure — every failed flush aborts its own
  // launch independently (see the H2a test above). The bounded-drain mechanism this test
  // exercised still exists (persistLaunchTokenHashAnchorWithRetry / drainLaunchTokenAnchorRetryQueue,
  // orca-runtime.ts:10636/10584) but is fed by a different call site now (the cold-restore/
  // registerPty sibling, ~:10761), out of scope for this pre-spawn anchor ruling. Rewritten to
  // assert the new, simpler guarantee: N independent flush failures abort N independent
  // launches, none anchored, none spawned — no queueing, no bound to test here.
  it('F2 (superseded by H2a): repeated flush failures abort each mint independently, with no queueing', async () => {
    const { store, sessionSnapshot, setFlushFailuresRemaining } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let spawnCount = 0
    runtime.setPtyController({
      spawn: async () => {
        spawnCount += 1
        return { id: `pty-f2-${spawnCount}` }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const FAILED_PANE_COUNT = 9
    const paneKeys: string[] = []
    for (let i = 0; i < FAILED_PANE_COUNT; i++) {
      const tabId = `tab-s10-17-f2-${i}`
      const leafId = `66666666-6666-4666-8666-66666666666${i}`
      paneKeys.push(makePaneKey(tabId, leafId))
      setFlushFailuresRemaining(1)
      await expect(
        runtime.createTerminal(`path:${WORKTREE_PATH}`, {
          credentialLane: { kind: 'shared' },
          command: 'claude',
          launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
          tabId,
          leafId,
          title: `agent-f2-${i}`
        })
      ).rejects.toThrow('launch_token_anchor_unavailable')
    }
    // None of the 9 aborted mints ever spawned a process or left an anchor behind.
    expect(spawnCount).toBe(0)
    for (const key of paneKeys) {
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[key]).toBeUndefined()
    }

    // A healthy-store launch afterward succeeds normally and is unaffected by the prior aborts.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_4,
      leafId: LEAF_ID_4,
      title: 'agent-f2-trigger'
    })
    expect(spawnCount).toBe(1)
    expect(
      sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[makePaneKey(TAB_ID_4, LEAF_ID_4)]
    ).toBeTruthy()
  })

  // H2a (F-6d, Ruling 32 Addendum 4) supersedes this test's original premise: step 1 now checks
  // isWritesFrozen() explicitly right after the (silently no-op) persist call and treats it as a
  // failure — aborting the launch, exactly like a thrown flush error, instead of letting an
  // unanchored token-bearing process spawn.
  it('H2a/F3: a frozen store is treated as a failed persist and aborts the launch before spawn', async () => {
    const { store, sessionSnapshot, setWritesFrozen } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let spawnCalled = false
    runtime.setPtyController(
      fakePtyController(() => {
        spawnCalled = true
      })
    )
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    setWritesFrozen(true)
    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        credentialLane: { kind: 'shared' },
        command: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        tabId: TAB_ID,
        leafId: LEAF_ID,
        title: 'agent-t1'
      })
    ).rejects.toThrow('launch_token_anchor_unavailable')
    // The spawn must never have been reached — no process ever held an unanchored token.
    expect(spawnCalled).toBe(false)
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // Unfreeze — an unrelated launch succeeds normally and is unaffected by the prior abort.
    setWritesFrozen(false)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'agent-t2'
    })
    const token2 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token2).toBeTruthy()
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY_2]).toBe(
      createHash('sha256').update(token2!).digest('hex')
    )
  })
})
