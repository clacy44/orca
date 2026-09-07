// S10-21c S1 (INV-P-014 amendment #1, UNRATIFIED): the persisted launch-token anchor's lifetime is
// the PTY's, not the foreground command's, and it is bound to the pane's pty identity
// (`<ptyId>:<incarnationId>`) recorded at mint. One rule replaces two ad-hoc deletion lifetimes:
// the anchor for pane P is valid only while P's live pty identity equals the binding; it dies when
// that identity changes, when the pty exits, or when the pane closes — never merely because a
// foreground command finished. These tests drive the REAL OrcaRuntimeService against a faithful
// two-map store fake (both `terminalLaunchTokenHashesByPaneKey` and its new sibling
// `terminalLaunchTokenAnchorPtyByPaneKey`), because the whole point of the change is what the two
// maps say TOGETHER.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-s10-21c'
const REPO_PATH = '/tmp/repo-s10-21c'
const WORKTREE_PATH = '/tmp/worktree-s10-21c'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): createTerminal's workspace-selector resolution shells out to
// `git worktree list` via listWorktrees — this suite is about anchor lifetime, not git plumbing
// (mirrors s10-17-attestation-anchor.test.ts). Why `vi.hoisted`: `vi.mock`'s factory is hoisted
// above every top-level const.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-s10-21c',
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

const TAB_ID = 'tab-s10-21c'
const LEAF_ID = '66666666-6666-4666-8666-666666666666'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-s10-21c-1'
const PTY_ID_2 = 'pty-s10-21c-2'
const INCARNATION = 'inc-s10-21c-1'
const INCARNATION_2 = 'inc-s10-21c-2'
const IDENTITY = `${PTY_ID}:${INCARNATION}`

type PersistArgs = {
  tabId: string
  leafId: string
  launchTokenHash: string
  anchorPty?: string | null
}

/** Faithful stand-in for persistence.ts's two host-owned anchor members: the hash and its pty
 *  binding move together, in one write, and are deleted together — exactly the property
 *  persistence-workspace-session-host-owned-anchor.test.ts proves against the REAL Store. */
function createSharedStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  sessionSnapshot: () => WorkspaceSessionState
} {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalLaunchTokenHashesByPaneKey: {},
    terminalLaunchTokenAnchorPtyByPaneKey: {}
  }
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 's10-21c-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 's10-21c',
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
    persistTerminalLaunchTokenHash: (args: PersistArgs) => {
      const paneKey = makePaneKey(args.tabId, args.leafId)
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [paneKey]: args.launchTokenHash
      }
      if (args.anchorPty) {
        session.terminalLaunchTokenAnchorPtyByPaneKey = {
          ...session.terminalLaunchTokenAnchorPtyByPaneKey,
          [paneKey]: args.anchorPty
        }
        return
      }
      // A mint that cannot name its pty leaves no binding behind — and must not inherit a
      // previous pty's, which would bind this token to a process that never held it.
      const { [paneKey]: _dropped, ...rest } = session.terminalLaunchTokenAnchorPtyByPaneKey ?? {}
      session.terminalLaunchTokenAnchorPtyByPaneKey = rest
    },
    forgetTerminalLaunchTokenHash: (paneKey: string) => {
      const { [paneKey]: _removedHash, ...restHashes } =
        session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = restHashes
      const { [paneKey]: _removedBinding, ...restBindings } =
        session.terminalLaunchTokenAnchorPtyByPaneKey ?? {}
      session.terminalLaunchTokenAnchorPtyByPaneKey = restBindings
    }
  }
  return { store, sessionSnapshot: () => session }
}

/** Plain fake controller: every spawn is a fresh mint on a pty with a real identity. */
function fakePtyController(
  onSpawn: (env: Record<string, string> | undefined) => void,
  identity: { id: string; incarnationId: string } = { id: PTY_ID, incarnationId: INCARNATION }
): {
  spawn: (args: { env?: Record<string, string> }) => Promise<{ id: string; incarnationId: string }>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
} {
  return {
    spawn: async (args) => {
      onSpawn(args.env)
      return { ...identity }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  }
}

function spawnTerminal(
  instance: OrcaRuntimeService,
  opts: Omit<Parameters<OrcaRuntimeService['createTerminal']>[1], 'restoreProvenance'>
): ReturnType<OrcaRuntimeService['createTerminal']> {
  return instance.createTerminal(`path:${WORKTREE_PATH}`, {
    restoreProvenance: { kind: 'none' },
    ...opts
  })
}

async function mintAnchoredPane(
  runtime: OrcaRuntimeService,
  identity: { id: string; incarnationId: string } = { id: PTY_ID, incarnationId: INCARNATION }
): Promise<string> {
  let capturedEnv: Record<string, string> | undefined
  runtime.setPtyController(
    fakePtyController((env) => (capturedEnv = env), identity) as Parameters<
      typeof runtime.setPtyController
    >[0]
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  await spawnTerminal(runtime, {
    credentialLane: { kind: 'shared' },
    command: 'claude',
    launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
    tabId: TAB_ID,
    leafId: LEAF_ID,
    title: 'anchor-agent'
  })
  const token = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
  expect(token).toBeTruthy()
  return token!
}

describe('S10-21c S1: the launch-token anchor is bound to pane-pty identity, not command lifetime', () => {
  it('command-finished on a non-peer-owned pane KEEPS the persisted anchor and its binding, and the pane still attests', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime)
    const hash = createHash('sha256').update(token).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)

    // The agent's foreground command exits; the PTY lives on. This is the field case the whole
    // item exists for (R3): the operator retypes `claude --resume …` in the same shell.
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)
    // The in-memory token is still cleared (arm 1 of the verifier finds nothing live), so this
    // true comes from the persisted anchor + its identity binding, exactly as a restored pane's does.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(true)
  })

  it('a real pty exit deletes both the anchor and its binding', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime)
    const hash = createHash('sha256').update(token).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)

    runtime.onPtyExit(PTY_ID, 0, INCARNATION as never)

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
  })

  it('INV-P-013: a PEER-OWNED pane still loses its anchor the moment its agent exits', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')
      const token = await mintAnchoredPane(runtime)
      const hash = createHash('sha256').update(token).digest('hex')
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)

      // The row is keyed on the terminal HANDLE the runtime minted for this pty — the same
      // resolution closePeerOwnedPaneOnAgentExit does (orca-runtime-peer-owned-pane-exit.test.ts).
      const handle = (
        runtime as unknown as { handleByPtyId: Map<string, string> }
      ).handleByPtyId.get(PTY_ID)!
      expect(handle).toBeTruthy()
      ;(
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
        }
      ).db
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
           VALUES ('disp_s10_21c', 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', ?, NULL)`
        )
        .run(runtime.getRuntimeId(), handle)

      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
      expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
      expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
    } finally {
      db.close()
    }
  })

  // [S10-21c B1b, D-R146 MEDIUM; corrected by D-R147 LOW finding 2] isPeerOwnedAttachmentPane
  // gains a pane-keyed fallback for the window the handle index misses: it is empty, OR the
  // row's own `terminal_handle` is STALE versus the pty's current handle (`prepareRemoteAttachmentAuthority`
  // is the only writer of `pane_key`, and it always stamps `terminal_handle` in the same UPDATE —
  // a row with `pane_key` set and `terminal_handle` NULL is a shape no writer produces). Three
  // states, one function, one shared fixture shape:
  it('D-R146 MEDIUM (a): a PEER-OWNED pane with a STALE handle still loses its anchor, via the pane-key fallback', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const token = await mintAnchoredPane(runtime)
      const hash = createHash('sha256').update(token).digest('hex')
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)

      // The row's terminal_handle is STALE (does not match this pty's current handle), so the
      // handle-keyed lookup misses — models a writable production shape, not the pane_key-only
      // shape a writer never produces (D-R147 LOW finding 2).
      ;(
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
        }
      ).db
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, pane_key, terminal_handle, agent_exited_at)
           VALUES ('disp_s10_21c_b1b_a', 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', ?, 'term_stale_s10_21c', NULL)`
        )
        .run(runtime.getRuntimeId(), PANE_KEY)

      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
      expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
      expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('D-R146 MEDIUM (b): a NON-peer pane with an unresolvable handle and no matching attachment row keeps its anchor', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const token = await mintAnchoredPane(runtime)
      const hash = createHash('sha256').update(token).digest('hex')

      // A DB is attached and reachable, but no row names this pane by either handle or pane_key
      // — this pane is genuinely not peer-owned.
      ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete(PTY_ID)

      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
      expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)
      expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('D-R146 MEDIUM (c): the post-restart window (no handle yet, no attachment row at all) keeps the anchor, never guesses peer-owned', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    // No OrchestrationDb attached at all — the state a runtime is in immediately after a
    // restart, before getOrchestrationDb()/setOrchestrationDb() has run.
    const token = await mintAnchoredPane(runtime)
    const hash = createHash('sha256').update(token).digest('hex')
    ;(runtime as unknown as { handleByPtyId: Map<string, string> }).handleByPtyId.delete(PTY_ID)

    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(true)
  })

  it('the persisted anchor verifies for the BOUND pty across a runtime restart, and refuses a different pty on the same pane', async () => {
    const { store } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime1)
    const hash = createHash('sha256').update(token).digest('hex')

    // Restart with the daemon-survived pty: same ptyId, same incarnation (the daemon owns both,
    // which is why `<ptyId>:<incarnationId>` is the identity this binds to).
    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION as never,
      isReattach: true
    })
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(true)

    // A DIFFERENT pty now standing on the same pane slot can never present the old pane's anchor.
    const runtime3 = new OrcaRuntimeService(store)
    runtime3.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime3.registerPty(PTY_ID_2, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_2 as never,
      isReattach: true
    })
    expect(runtime3.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
  })

  it('the same ptyId under a NEW incarnation refuses — a respawn in the pane slot is not the minting process', async () => {
    const { store } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime1)
    const hash = createHash('sha256').update(token).digest('hex')

    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_2 as never,
      isReattach: true
    })
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
  })

  it('a pane with NO live pty cannot attest from the persisted anchor at all', async () => {
    const { store } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime1)
    const hash = createHash('sha256').update(token).digest('hex')

    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
  })

  it('a legacy binding-less entry is honoured once against the live pty and upgraded in place', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const legacyHash = createHash('sha256').update('legacy-generation-token').digest('hex')
    // Exactly what a pre-10n build left on disk: a hash with no binding beside it.
    const session = sessionSnapshot()
    session.terminalLaunchTokenHashesByPaneKey = { [PANE_KEY]: legacyHash }
    session.terminalLaunchTokenAnchorPtyByPaneKey = {}

    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION as never,
      isReattach: true
    })

    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, legacyHash)).toBe(true)
    // Upgraded in place to the pty that was live on this exact pane at that moment — every later
    // verify takes the bound path, so the compatibility lane is one verify wide, not permanent.
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)

    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID_2, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_2 as never,
      isReattach: true
    })
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, legacyHash)).toBe(false)
  })

  it('a legacy binding-less entry with NO live pty on the pane is refused, not honoured', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const legacyHash = createHash('sha256').update('legacy-generation-token').digest('hex')
    const session = sessionSnapshot()
    session.terminalLaunchTokenHashesByPaneKey = { [PANE_KEY]: legacyHash }
    session.terminalLaunchTokenAnchorPtyByPaneKey = {}

    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, legacyHash)).toBe(false)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  it('H2d: an attach-only adopt of the SAME pty preserves the anchor; a plain-shell relaunch on a new pty still forgets it', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const token = await mintAnchoredPane(runtime)
    const hash = createHash('sha256').update(token).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)

    // The attach-only adopt: `adoptStablePane` resolves an owner (so E1 suppresses the mint and
    // `launchToken` is undefined — the H2d leg) while the spawn reports NO `stablePaneOwner`, the
    // NON-materialized pre-adopt shape (pty.ts:4651 takes its early return only when
    // `materialized` is set). This is the reattach that recovers a daemon-survived pane, and
    // before S1 it destroyed the very anchor it was recovering.
    runtime.setPtyController({
      adoptStablePane: async (opts: { tabId: string; leafId: string }) => ({
        result: { id: PTY_ID, incarnationId: INCARNATION },
        owner: { tabId: opts.tabId, leafId: opts.leafId, ptyId: PTY_ID }
      }),
      spawn: async () => ({ id: PTY_ID, incarnationId: INCARNATION }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    } as unknown as Parameters<typeof runtime.setPtyController>[0])
    await spawnTerminal(runtime, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'anchor-agent-reattach'
    })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBe(IDENTITY)
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(true)

    // S10-17/F4, now enforced by identity rather than by "no token was minted this call": a plain
    // shell on the same pane spawns a NEW pty, whose identity differs — the anchor still dies.
    runtime.setPtyController(
      fakePtyController(() => {}, { id: PTY_ID_2, incarnationId: INCARNATION_2 }) as Parameters<
        typeof runtime.setPtyController
      >[0]
    )
    await spawnTerminal(runtime, {
      credentialLane: { kind: 'shared' },
      command: 'bash',
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'plain-shell'
    })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, hash)).toBe(false)
  })

  // [S10-21c B1b, D-R146 LOW finding 3] `verifyLivePaneLaunchTokenHash`'s legacy-lane upgrade is
  // reachable from the hook channel (isCorroboratedAuthority arm 1). This proves the mutation
  // guard: a queued retry from a FAILED upgrade write must not survive the pty's own exit, or a
  // later unrelated drain could resurrect a binding for a pane that has already retired.
  it('D-R146 LOW (item 3): a legacy-lane upgrade queued after a failed flush is dropped by a subsequent pty_exit retire, so a later drain cannot resurrect it', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const legacyHash = createHash('sha256').update('legacy-generation-token-retry').digest('hex')
    const session = sessionSnapshot()
    session.terminalLaunchTokenHashesByPaneKey = { [PANE_KEY]: legacyHash }
    session.terminalLaunchTokenAnchorPtyByPaneKey = {}

    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION as never,
      isReattach: true
    })

    // Force exactly one persist call to fail, so the legacy-lane upgrade's own write is queued
    // for retry instead of landing on disk.
    const originalPersist = store!.persistTerminalLaunchTokenHash!
    let failNext = true
    store!.persistTerminalLaunchTokenHash = ((...args: Parameters<typeof originalPersist>) => {
      if (failNext) {
        failNext = false
        throw new Error('simulated flush failure')
      }
      return originalPersist(...args)
    }) as typeof originalPersist

    // The legacy entry is honoured in-memory even though its upgrade write failed.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, legacyHash)).toBe(true)
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()

    // The pty then genuinely exits. retirePtyAgentLaunchAuthority('pty_exit') must drop the
    // queued retry for this pane's key, not just forget the (already-empty) persisted anchor.
    runtime.onPtyExit(PTY_ID, 0, INCARNATION as never)

    // Un-freeze the store, then drive exactly the mechanism the finding names: a LATER drain.
    // If the queued upgrade survived the retire, this call would resurrect the binding for a
    // pane whose pty has already exited.
    failNext = false
    ;(
      runtime as unknown as { drainLaunchTokenAnchorRetryQueue: () => void }
    ).drainLaunchTokenAnchorRetryQueue()

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})

// [S10-21c B1c, D-R147 MEDIUM] The hook-side authority retire must fire whenever the persisted
// anchor is retired, even when the in-memory token/receipt were already null — a corroborated
// hook POST can re-populate the hook server's own authority maps between an earlier
// command_finished and a later pty_exit, and only the retire itself revokes them.
describe('S10-21c B1c, D-R147 MEDIUM: the hook-side authority retire follows retiresPersistedAnchor, not the token/receipt early return', () => {
  it('(a) command_finished then pty_exit on a non-peer pane: the hook authority is retired exactly once, at pty_exit, even though pty.launchToken was already null', async () => {
    const { store } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    await mintAnchoredPane(runtime1)

    // A daemon-survived reattach: registerPty leaves pty.launchToken null and no receipt — the
    // exact state command_finished sees when the pane's token was never re-minted this
    // generation (S10-10 F1 residual, the comment at retirePtyAgentLaunchAuthority's call site).
    const retireAgentHookCompatibilityAuthority = vi.fn()
    const runtime2 = new OrcaRuntimeService(store, undefined, {
      retireAgentHookCompatibilityAuthority
    })
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION as never,
      isReattach: true
    })

    runtime2.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
    expect(retireAgentHookCompatibilityAuthority).not.toHaveBeenCalled()

    runtime2.onPtyExit(PTY_ID, 0, INCARNATION as never)
    expect(retireAgentHookCompatibilityAuthority).toHaveBeenCalledTimes(1)
    expect(retireAgentHookCompatibilityAuthority).toHaveBeenCalledWith(PANE_KEY)
  })

  it('(b) command_finished alone (non-peer pane, no live token/receipt): the hook authority is not retired', async () => {
    const { store } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    await mintAnchoredPane(runtime1)

    const retireAgentHookCompatibilityAuthority = vi.fn()
    const runtime2 = new OrcaRuntimeService(store, undefined, {
      retireAgentHookCompatibilityAuthority
    })
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION as never,
      isReattach: true
    })

    runtime2.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    expect(retireAgentHookCompatibilityAuthority).not.toHaveBeenCalled()
  })

  it('(c) a PEER-OWNED pane on command_finished: the hook authority is still retired (unchanged)', async () => {
    const { store } = createSharedStore()
    const retireAgentHookCompatibilityAuthority = vi.fn()
    const runtime = new OrcaRuntimeService(store, undefined, {
      retireAgentHookCompatibilityAuthority
    })
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')
      await mintAnchoredPane(runtime)

      const handle = (
        runtime as unknown as { handleByPtyId: Map<string, string> }
      ).handleByPtyId.get(PTY_ID)!
      ;(
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
        }
      ).db
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, terminal_handle, agent_exited_at)
           VALUES ('disp_s10_21c_r147_c', 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', ?, NULL)`
        )
        .run(runtime.getRuntimeId(), handle)

      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

      expect(retireAgentHookCompatibilityAuthority).toHaveBeenCalledTimes(1)
      expect(retireAgentHookCompatibilityAuthority).toHaveBeenCalledWith(PANE_KEY)
    } finally {
      db.close()
    }
  })
})

// [S10-21c B1c, D-R147 LOW finding 3] closePeerOwnedPaneOnAgentExit gains the same pane-keyed
// fallback isPeerOwnedAttachmentPane already has, so both INV-P-013 halves (anchor delete, pane
// close) agree on the same set of rows a stale/unresolvable handle can no longer find.
describe('S10-21c B1c, D-R147 LOW finding 3: closePeerOwnedPaneOnAgentExit pane-keyed fallback', () => {
  it('a PEER-OWNED pane with a STALE terminal_handle is both closed and has its anchor deleted, via the pane-key fallback', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      runtime.setPeerGrantProfileLookup(() => 'peer')
      const token = await mintAnchoredPane(runtime)
      const hash = createHash('sha256').update(token).digest('hex')
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)

      const closeTerminal = vi
        .spyOn(runtime, 'closeTerminal')
        .mockResolvedValue({ handle: 'unused', accepted: true, exited: true } as never)

      // The row's terminal_handle is STALE — the handle-keyed lookup misses, so both halves must
      // fall back to pane_key.
      ;(
        db as unknown as {
          db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
        }
      ).db
        .prepare(
          `INSERT INTO remote_dispatch_attachments
             (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, pane_key, terminal_handle, agent_exited_at)
           VALUES ('disp_s10_21c_r147_3', 'task_x', 'fp_peer', ?, 'ready', 'input_accepted', ?, 'term_stale_r147_3', NULL)`
        )
        .run(runtime.getRuntimeId(), PANE_KEY)

      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

      // Anchor delete half (isPeerOwnedAttachmentPane's own pane-key fallback, D-R146 MEDIUM):
      // synchronous within retirePtyAgentLaunchAuthority.
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
      expect(sessionSnapshot().terminalLaunchTokenAnchorPtyByPaneKey?.[PANE_KEY]).toBeUndefined()

      // Pane-close half (this item's own fix): fire-and-forget, drain it.
      await vi.waitFor(() => {
        expect(
          db.getRemoteDispatchAttachment('disp_s10_21c_r147_3')?.agent_exited_at
        ).not.toBeNull()
      })
      expect(closeTerminal).toHaveBeenCalled()
      const row = db.getRemoteDispatchAttachment('disp_s10_21c_r147_3')
      expect(row?.state).toBe('agent_exited')
    } finally {
      db.close()
    }
  })
})
