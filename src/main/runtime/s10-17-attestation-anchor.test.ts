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
const PTY_ID = 'pty-s10-17-1'
const PTY_ID_2 = 'pty-s10-17-2'

// Why real semantics matter (mirrors s10-10-restored-launch-token-anchor.test.ts): faking the
// storage medium is fine, faking persistTerminalLaunchTokenHash's/flush's behavior would defeat
// the test. `flushFailuresRemaining` lets a test force the E3 retry path.
function createSharedStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  sessionSnapshot: () => WorkspaceSessionState
  setFlushFailuresRemaining: (n: number) => void
} {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalLaunchTokenHashesByPaneKey: {}
  }
  let flushFailuresRemaining = 0
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
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [makePaneKey(args.tabId, args.leafId)]: args.launchTokenHash
      }
    },
    forgetTerminalLaunchTokenHash: (paneKey: string) => {
      const { [paneKey]: _removed, ...rest } = session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = rest
    }
  }
  return {
    store,
    sessionSnapshot: () => session,
    setFlushFailuresRemaining: (n: number) => {
      flushFailuresRemaining = n
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

/** Adopting fake pty controller: `adoptStablePane` resolves truthy on demand (via
 *  `armAdoption`), and `spawn` echoes that decision back as `stablePaneOwner` the way
 *  pty.ts's real stable-pane path does — this is what flips `adoptedStablePane` to true
 *  in createTerminal (orca-runtime.ts, mirrors the adoption fixture in orca-runtime.test.ts). */
function fakeAdoptingPtyController(onSpawn: (args: { env?: Record<string, string> }) => void): {
  adoptStablePane: (opts: {
    tabId: string
    leafId: string
  }) => Promise<{
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

  it('adopted pane with no delivered token is refused at the evidence-shape gate and gains no anchor', async () => {
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

    // Evidence-shape gate: an empty/undelivered token refuses before any anchor lookup runs.
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: adopted.handle,
        paneKey: PANE_KEY,
        launchToken: ''
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
    const revealCalls: Record<string, unknown>[] = []
    runtime.setNotifier({
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
    } as Parameters<typeof runtime.setNotifier>[0])
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
})
