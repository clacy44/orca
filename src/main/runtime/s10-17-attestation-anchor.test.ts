// S10-17: the defect closed here is a mint/publish asymmetry, not a verification-logic bug.
// createTerminal minted ORCA_AGENT_LAUNCH_TOKEN unconditionally, even for an ADOPTED pane
// (attach-only spawn, no env — pty.ts's attachStablePaneOwner) where the token can never reach
// the live process, and still published it to the renderer via revealTerminalSession. E1 gates
// the mint on `!adoptedBeforeLaunch`; E2 gates the publish on `!adoptedStablePane`; E3 adds a
// bounded retry queue so a failed anchor-persist flush is not silently lost (F8: never abort the
// launch on a flush failure). This suite proves: the persisted anchor from a genuine mint is
// never clobbered by an adoption (regression for what E1 protects), a replayed/cloned/undelivered
// token is refused, adoption never leaks a token to the renderer, and E3's retry drains.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-s10-17'
const REPO_PATH = '/tmp/repo-s10-17'
const WORKTREE_PATH = '/tmp/worktree-s10-17'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): createTerminal's workspace-selector resolution shells out to
// `git worktree list` via listWorktrees — this suite is about the runtime's anchor/token
// correctness, not git plumbing (mirrors s10-10-restored-launch-token-anchor.test.ts). Why
// `vi.hoisted`: `vi.mock`'s factory is hoisted above every top-level const.
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
const PTY_ID_2 = 'pty-s10-17-2'

// Why real semantics matter (mirrors s10-10-restored-launch-token-anchor.test.ts): faking the
// storage medium is fine, faking persistTerminalLaunchTokenHash's/flush's behavior would defeat
// the test. `flushFailuresRemaining` lets a test force the E3 retry path.
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
  // S10-17/F3: mirrors persistence.ts's writeToDiskSync — a frozen store writes nothing
  // and throws nothing, the one case flushOrThrow's caller cannot detect by exception alone.
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
        // Mirrors writeToDiskSync: returns silently, writes nothing, throws nothing.
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

/** A notifier whose revealTerminalSession captures every reveal payload for inspection. */
function fakeRevealCapturingNotifier(): {
  notifier: unknown
  revealCalls: Record<string, unknown>[]
} {
  const revealCalls: Record<string, unknown>[] = []
  return {
    revealCalls,
    notifier: {
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: async (_worktreeId: string, payload: Record<string, unknown>) => {
        revealCalls.push(payload)
        return { tabId: payload.tabId as string }
      },
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    }
  }
}

/** Adopting fake pty controller: `adoptStablePane` resolves truthy on demand (via
 *  `armAdoption`), and `spawn` echoes that decision back as `stablePaneOwner` the way
 *  pty.ts's real stable-pane path does — this is what flips `adoptedStablePane` to true
 *  in createTerminal (orca-runtime.ts, mirrors the adoption fixture in orca-runtime.test.ts). */
function fakeAdoptingPtyController(onSpawn: (args: { env?: Record<string, string> }) => void): {
  adoptStablePane: (opts: { tabId: string; leafId: string }) => Promise<{
    result: { id: string }
    owner: { tabId: string; leafId: string; ptyId: string }
  } | null>
  spawn: (args: {
    env?: Record<string, string>
    tabId?: string
    leafId?: string
    adoptedStablePane?: unknown
  }) => Promise<{
    id: string
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  }>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
  armAdoption: (armed: boolean) => void
} {
  let adoptionArmed = false
  return {
    adoptStablePane: async (opts) =>
      adoptionArmed
        ? {
            result: { id: PTY_ID },
            owner: { tabId: opts.tabId, leafId: opts.leafId, ptyId: PTY_ID }
          }
        : null,
    spawn: async (args) => {
      onSpawn(args)
      return args.adoptedStablePane
        ? {
            id: PTY_ID,
            stablePaneOwner: { handle: PTY_ID, tabId: args.tabId!, leafId: args.leafId! }
          }
        : { id: PTY_ID }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    armAdoption: (armed: boolean) => {
      adoptionArmed = armed
    }
  }
}

/** S10-17/F4: models pty.ts's IN-SPAWN adoption — `spawn` itself resolves a stable owner
 *  and reports `stablePaneOwner` on its result, independent of any `adoptedStablePane` hint
 *  the caller passed in (`adoptStablePane` never resolves one ahead of the spawn, so
 *  `adoptedBeforeLaunch` stays falsy and E1 still mints). This is the case E2 exists for:
 *  `fakeAdoptingPtyController` above only reports an owner when the caller already told it
 *  to, which cannot fail without E2 since the mint is already suppressed by E1. */
function fakeInSpawnAdoptingPtyController(
  onSpawn: (args: { env?: Record<string, string> }) => void
): {
  adoptStablePane: () => Promise<null>
  spawn: (args: { env?: Record<string, string>; tabId?: string; leafId?: string }) => Promise<{
    id: string
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
  }>
  write: () => boolean
  kill: () => boolean
  getForegroundProcess: () => Promise<null>
  armAdoption: (armed: boolean) => void
} {
  let adoptOnSpawn = false
  return {
    adoptStablePane: async () => null,
    spawn: async (args) => {
      onSpawn(args)
      return adoptOnSpawn
        ? {
            id: PTY_ID,
            stablePaneOwner: { handle: PTY_ID, tabId: args.tabId!, leafId: args.leafId! }
          }
        : { id: PTY_ID }
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    armAdoption: (armed: boolean) => {
      adoptOnSpawn = armed
    }
  }
}

describe('S10-17: launch-token anchor correctness', () => {
  it('anchor-clobber regression: adopting the pane leaves the persisted anchor byte-identical and injects no token', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const spawnCalls: { env?: Record<string, string>; adoptedStablePane?: unknown }[] = []
    const controller = fakeAdoptingPtyController((args) => spawnCalls.push(args))
    runtime.setPtyController(controller)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    const token1 = spawnCalls[0]?.env?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()
    const hash1 = createHash('sha256').update(token1!).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)

    // Second createTerminal on the SAME pane adopts (attach-only) instead of minting fresh.
    controller.armAdoption(true)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-reattach'
    })

    // The persisted anchor from generation 1 must be untouched (byte-identical).
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)
    // E1: the adopted spawn's env must carry no launch token at all.
    expect(spawnCalls[1]?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
  })

  it('replayed/undelivered token refused: any token other than the genuine one is refused', async () => {
    const { store } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    const token1 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()

    // currentRuntimeLaunchSufficient mirrors every real RPC caller (orchestration.ts,
    // orchestration-agents-register.ts, etc.) — a fresh, still-live launch may skip hook
    // attestation only on an exact live-pane match against its own genuine token.
    expect(
      runtime.verifyOrchestrationCompatibilityCaller(
        {
          terminalHandle: terminal.handle,
          paneKey: PANE_KEY,
          launchToken: token1!
        },
        { currentRuntimeLaunchSufficient: true }
      )
    ).toMatchObject({ paneKey: PANE_KEY })
    expect(
      runtime.verifyOrchestrationCompatibilityCaller(
        {
          terminalHandle: terminal.handle,
          paneKey: PANE_KEY,
          launchToken: 'replayed-or-forged-token'
        },
        { currentRuntimeLaunchSufficient: true }
      )
    ).toBeNull()
  })

  it("cloned-env token refused: pane P2 presenting P1's genuine token is refused (paneKey-keyed)", async () => {
    const { store } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const envsByCall: (Record<string, string> | undefined)[] = []
    runtime.setPtyController({
      spawn: async (args: { env?: Record<string, string> }) => {
        envsByCall.push(args.env)
        return { id: envsByCall.length === 1 ? PTY_ID : PTY_ID_2 }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const p1 = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'p1'
    })
    const p2 = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'p2'
    })
    const p1Token = envsByCall[0]?.ORCA_AGENT_LAUNCH_TOKEN
    expect(p1Token).toBeTruthy()
    void p1

    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: p2.handle,
        paneKey: PANE_KEY_2,
        launchToken: p1Token!
      })
    ).toBeNull()
  })

  it('adopted pane with no delivered token is refused by the anchor logic and gains no anchor', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const spawnCalls: { env?: Record<string, string>; adoptedStablePane?: unknown }[] = []
    const controller = fakeAdoptingPtyController((args) => spawnCalls.push(args))
    runtime.setPtyController(controller)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    controller.armAdoption(true)
    const adopted = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-reattach'
    })
    const hashBeforeEmptyAttempt = sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]

    // F9: a well-formed but wrong token exercises the anchor/live-token logic itself,
    // not the evidence-shape gate (an empty string would refuse before reaching it).
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: adopted.handle,
        paneKey: PANE_KEY,
        launchToken: 'well-formed-but-wrong-launch-token'
      })
    ).toBeNull()
    // The adoption itself must not have written a fresh (undeliverable) anchor.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(
      hashBeforeEmptyAttempt
    )
  })

  it('no token reaches the renderer on adoption: revealTerminalSession omits launchToken', async () => {
    const { store } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const controller = fakeAdoptingPtyController(() => {})
    runtime.setPtyController(controller)
    const { notifier, revealCalls } = fakeRevealCapturingNotifier()
    runtime.setNotifier(notifier as Parameters<typeof runtime.setNotifier>[0])
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1',
      presentation: 'focused'
    })
    controller.armAdoption(true)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-reattach',
      presentation: 'focused'
    })

    expect(revealCalls[0]).toHaveProperty('launchToken')
    expect(revealCalls[1]).not.toHaveProperty('launchToken')
  })

  it('F4: in-spawn adoption (owner resolved inside spawn, not pre-flighted) delivers no token and writes no anchor', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const spawnCalls: { env?: Record<string, string> }[] = []
    const controller = fakeInSpawnAdoptingPtyController((args) => spawnCalls.push(args))
    runtime.setPtyController(controller)
    const { notifier, revealCalls } = fakeRevealCapturingNotifier()
    runtime.setNotifier(notifier as Parameters<typeof runtime.setNotifier>[0])
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // Generation 1: adoptStablePane never resolves an owner and spawn does not report one
    // either — a genuine mint, so pane P is left with a live token/anchor.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1',
      presentation: 'focused'
    })
    const hashAfterGenuineMint = sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]
    expect(hashAfterGenuineMint).toBeTruthy()

    // Generation 2: adoptStablePane STILL resolves nothing beforehand (adoptedBeforeLaunch
    // stays falsy, so E1 mints), but this time spawn itself reports stablePaneOwner — the
    // in-spawn adoption E2 exists for. Without E2 this reveal would carry a dead-on-arrival
    // token.
    controller.armAdoption(true)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-reattach',
      presentation: 'focused'
    })

    expect(revealCalls[0]).toHaveProperty('launchToken')
    // F4: this is the assertion that fails without E2 — in-spawn adoption still minted
    // (E1's gate never saw it coming), so only the publish gate can stop delivery.
    expect(revealCalls[1]).not.toHaveProperty('launchToken')
    // The genuine generation-1 anchor must be untouched by the in-spawn adoption.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(
      hashAfterGenuineMint
    )
  })

  it('E3: a failed anchor flush does not abort the launch, and the anchor lands after the next successful flush', async () => {
    const { store, sessionSnapshot, setFlushFailuresRemaining } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    setFlushFailuresRemaining(1)
    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    // F8: the launch itself must have succeeded despite the persist call throwing.
    expect(terminal.handle).toBeTruthy()
    const token1 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()
    const hash1 = createHash('sha256').update(token1!).digest('hex')
    // Not yet anchored — the only flush attempt so far failed.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // A second, unrelated launch causes the next anchor-persist call to succeed, which must
    // drain the queued retry from generation 1 as a side effect.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'agent-t2'
    })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)
  })

  it('F1: forgetting an anchor also drops its queued retry, at both forget sites', async () => {
    const { store, sessionSnapshot, setFlushFailuresRemaining } = createSharedStore()
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
    setFlushFailuresRemaining(1)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    // Queued, not yet anchored — the only flush attempt so far failed.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    // command-finished fires the retire lever, which forgets pane P's anchor.
    runtime.emitDaemonPtyTransientFact('pty-f1-1', { kind: 'command-finished', exitCode: 0 })

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
    setFlushFailuresRemaining(1)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_3,
      leafId: LEAF_ID_3,
      title: 'agent-t3'
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY_3]).toBeUndefined()
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

  it('F2: the drain retries at most 8 entries per successful persist, the rest stay queued', async () => {
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
      await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        credentialLane: { kind: 'shared' },
        command: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        tabId,
        leafId,
        title: `agent-f2-${i}`
      })
    }
    for (const key of paneKeys) {
      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[key]).toBeUndefined()
    }

    // One more launch succeeds on the first attempt, triggering exactly one bounded drain.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_4,
      leafId: LEAF_ID_4,
      title: 'agent-f2-trigger'
    })

    const drainedCount = paneKeys.filter(
      (key) => sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[key] !== undefined
    ).length
    const stillQueuedCount = paneKeys.length - drainedCount
    expect(drainedCount).toBe(8)
    expect(stillQueuedCount).toBe(1)
  })

  it('F3: a frozen store (writes silently no-op) is treated as a failed persist, not a success', async () => {
    const { store, sessionSnapshot, setWritesFrozen } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    setWritesFrozen(true)
    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    // F8: never abort the launch even though the store is frozen.
    expect(terminal.handle).toBeTruthy()
    const token1 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()
    const hash1 = createHash('sha256').update(token1!).digest('hex')
    // The frozen write returned normally with nothing on disk — must not be read as success.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()

    // Unfreeze and cause an unrelated anchor persist to succeed — must drain the queued retry.
    setWritesFrozen(false)
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID_2,
      leafId: LEAF_ID_2,
      title: 'agent-t2'
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)
  })

  it('F5: agent-session resume-adopt of a live pty keeps its existing token/anchor and delivers no new mint', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const spawnCalls: {
      env?: Record<string, string>
      tabId?: string
      leafId?: string
      preAllocatedHandle?: string
      agentSessionEnsure?: {
        claim: unknown
        surface: { worktreeId: string; tabId: string; leafId: string; terminalHandle: string }
      }
    }[] = []
    runtime.setPtyController({
      spawn: async (args) => {
        spawnCalls.push(args)
        // Models claimed-agent-pty-owner.ts's ensure(): a live owner is adopted WITHOUT
        // calling the provider's spawn — the env (and any freshly minted token in it) is
        // never delivered anywhere.
        if (args.agentSessionEnsure) {
          return {
            id: PTY_ID,
            agentSessionEnsure: {
              disposition: 'adopted' as const,
              owner: {
                claim: args.agentSessionEnsure.claim,
                generation: 'live-gen-1',
                phase: 'live' as const,
                ptyId: PTY_ID,
                surface: {
                  worktreeId: WORKTREE_ID,
                  tabId: args.tabId!,
                  leafId: args.leafId!,
                  terminalHandle: args.preAllocatedHandle!
                }
              }
            }
          }
        }
        return { id: PTY_ID }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // Generation 1: a genuine spawn mints and anchors a live token for pane P.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    const token1 = spawnCalls[0]?.env?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()
    const hash1 = createHash('sha256').update(token1!).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)

    // Resume: agentSessionEnsure adopts the SAME live pty without spawning.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-resume',
      agentSessionClaim: {
        digestVersion: 1,
        keyId: 'k1',
        identityDigest: 'd1',
        worktreeScopeDigest: 'w1',
        agent: 'claude'
      }
    })
    const token2 = spawnCalls[1]?.env?.ORCA_AGENT_LAUNCH_TOKEN
    // A second mint DID happen (E1's gate only fires on adoptStablePane, which this
    // controller has none of) — the point of F5 is that it must go nowhere.
    expect(token2).toBeTruthy()
    expect(token2).not.toBe(token1)

    // F5: the live agent's token and anchor must be unchanged — no clobber, no new
    // mint delivered.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)
  })

  it('F5 caveat: a daemon-survived pane resume-adopted after a restart (launchToken null, providerResult null) keeps its persisted anchor and reveals nothing', async () => {
    const { store, sessionSnapshot } = createSharedStore()

    // Generation 1: a genuine spawn mints and anchors a live token for pane P.
    const runtime1 = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime1.setPtyController({
      spawn: async (args) => {
        capturedEnv = args.env
        return { id: PTY_ID }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime1.attachWindow(1)
    runtime1.syncWindowGraph(1, { tabs: [], leaves: [] })
    await runtime1.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1'
    })
    const token1 = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token1).toBeTruthy()
    const hash1 = createHash('sha256').update(token1!).digest('hex')
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)

    // Restart: fresh runtime, registerPty (real path, no agentLaunchAuthority) leaves
    // pty.launchToken null — the daemon-survived shape — while the shared store still
    // carries generation 1's persisted anchor (mirrors s10-10's restart step).
    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 's10-17-f5-caveat-gen2',
      isReattach: true
    })

    // Resume: agentSessionEnsure adopts the restored pty WITHOUT spawning
    // (providerResult null, pty.ts:5054-5060) — a daemon-survived owner found by ensure().
    const { notifier, revealCalls } = fakeRevealCapturingNotifier()
    runtime2.setNotifier(notifier as Parameters<typeof runtime2.setNotifier>[0])
    runtime2.setPtyController({
      spawn: async (args) => ({
        id: PTY_ID,
        agentSessionEnsure: {
          disposition: 'adopted' as const,
          owner: {
            claim: args.agentSessionEnsure!.claim,
            generation: 'live-gen-2',
            phase: 'live' as const,
            ptyId: PTY_ID,
            surface: {
              worktreeId: WORKTREE_ID,
              tabId: args.tabId!,
              leafId: args.leafId!,
              terminalHandle: args.preAllocatedHandle!
            }
          }
        }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime2.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'agent-t1-restart-resume',
      presentation: 'focused',
      agentSessionClaim: {
        digestVersion: 1,
        keyId: 'k1',
        identityDigest: 'd1',
        worktreeScopeDigest: 'w1',
        agent: 'claude'
      }
    })

    // F5 caveat: the genuine pre-restart anchor must survive — no mint delivered into the
    // record, no overwrite of the persisted hash.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash1)
    // The reveal fires (as any focused create does) but must never carry a token — the
    // reveal-gate half of this fix (`!resumedLiveAgentSession` on the launchToken spread).
    expect(revealCalls).toHaveLength(1)
    expect(revealCalls[0]).not.toHaveProperty('launchToken')
    // The genuine token still corroborates against the untouched persisted anchor.
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, hash1)).toBe(true)
  })
})
