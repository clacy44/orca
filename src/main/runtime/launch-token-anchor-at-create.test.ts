// H2a (F-6d, Ruling 32 Addendum 4): createTerminal now anchors the launch-token hash BEFORE
// spawn (persist-before-spawn, persistence.ts:7045's flushOrThrow proves it durable before the
// env carrying the token reaches any process) and gates the in-memory pty.launchToken mirror on
// runtime-local facts alone — no provider-reported disposition (`agentSessionEnsure.disposition`
// can say 'adopted' after a genuine spawn already ran, which is exactly the corner F-6d
// exploited: a resume-adopted pane that DID receive its token in a real process's env, but whose
// record the old `!resumedLiveAgentSession` gate skipped unconditionally).
//
// This suite drives the REAL createTerminal against a fake ptyController and the real store/
// register-RPC handler, reproducing the field shape from
// orchestration/runs/s10-15/field-run-10i/F-6d-agent-pane-register-rootcause.md: a resume-adopt
// whose underlying spawn call genuinely ran (unlike a pre-flight/attach-only adopt).
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_AGENTS_REGISTER_METHODS } from './rpc/methods/orchestration-agents-register'
import type { RpcContext } from './rpc/core'
import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-h2a'
const REPO_PATH = '/tmp/repo-h2a'
const WORKTREE_PATH = '/tmp/worktree-h2a'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): mirrors s10-10-restored-launch-token-anchor.test.ts and
// s10-17-attestation-anchor.test.ts — createTerminal's workspace-selector resolution shells out
// to `git worktree list`; this suite is about the anchor/gate correctness, not git plumbing.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-h2a',
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

const TAB_ID = 'tab-h2a'
const LEAF_ID = '77777777-7777-4777-8777-777777777777'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const NEW_PTY_ID = 'pty-h2a-new-1'

const DEST_TAB_ID = 'tab-h2a-dest'
const DEST_LEAF_ID = '88888888-8888-4888-8888-888888888888'
const DEST_PANE_KEY = makePaneKey(DEST_TAB_ID, DEST_LEAF_ID)

/** A minimal but faithful stand-in for persistence.ts's PersistenceStore, mirroring
 *  s10-10-restored-launch-token-anchor.test.ts / s10-17-attestation-anchor.test.ts:
 *  real read/write semantics for the members this ticket touches, and hooks to force a
 *  throwing or silently-frozen flush on demand. */
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
      { id: REPO_ID, path: REPO_PATH, displayName: 'h2a-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'h2a',
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
        // Mirrors persistence.ts's writeToDiskSync: returns silently, writes nothing.
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

function registerMethod() {
  const found = ORCHESTRATION_AGENTS_REGISTER_METHODS.find(
    (m) => m.name === 'orchestration.agents.register'
  )
  if (!found) {
    throw new Error('orchestration.agents.register method not found')
  }
  return found
}

async function callRegister(
  runtime: OrcaRuntimeService,
  evidence: { terminalHandle: string; paneKey: string; launchToken: string }
): Promise<unknown> {
  const m = registerMethod()
  const parsed = m.params ? m.params.parse({ name: `h2a-agent-${Date.now()}` }) : undefined
  const ctx: RpcContext = { runtime, orchestrationCompatibilityEvidence: evidence }
  return m.handler(parsed, ctx)
}

describe('H2a (F-6d, Ruling 32 Addendum 4): launch-token anchor at create', () => {
  let db: OrchestrationDb | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  // T2: field repro. A resume-adopt whose underlying spawn genuinely ran (real process,
  // real env, real token) — faithful to pty.ts:5251-5255's adopted-branch return shape:
  // {id, incarnationId?, agentSessionEnsure}, nothing else. Must fail at fd0b4833d8 (no
  // anchor, no pty.launchToken — F-6d's exact reported defect).
  it('T2: a resume-adopt whose spawn genuinely delivered the token anchors it and registers with authority', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(db)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController({
      spawn: async (args: {
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        preAllocatedHandle?: string
        agentSessionEnsure?: { claim: AgentSessionExecutionClaim }
      }) => {
        capturedEnv = args.env
        // Faithful to pty.ts:5251-5255's adopted early return: {id, incarnationId?,
        // agentSessionEnsure}, no stablePaneOwner, no launchTokenDelivered (removed), and
        // owner.surface equal to the REQUESTED tabId/leafId/terminalHandle (no redirect).
        return {
          id: NEW_PTY_ID,
          incarnationId: 'h2a-t2-incarnation',
          agentSessionEnsure: {
            disposition: 'adopted' as const,
            owner: {
              claim: args.agentSessionEnsure!.claim,
              generation: 'live-gen-1',
              phase: 'live' as const,
              ptyId: NEW_PTY_ID,
              surface: {
                worktreeId: WORKTREE_ID,
                tabId: args.tabId!,
                leafId: args.leafId!,
                terminalHandle: args.preAllocatedHandle!
              }
            }
          }
        }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'h2a-t2',
      agentSessionClaim: {
        digestVersion: 1,
        keyId: 'k1',
        identityDigest: 'd1',
        worktreeScopeDigest: 'w1',
        agent: 'claude'
      }
    })

    const token = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token).toBeTruthy()
    const hash = createHash('sha256').update(token!).digest('hex')

    // The anchor is on disk (step 1, before spawn).
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)

    // The real register handler grants authority for this pane.
    const authority = (await callRegister(runtime, {
      terminalHandle: terminal.handle,
      paneKey: PANE_KEY,
      launchToken: token!
    })) as { agent?: { paneKey?: string } }
    expect(authority).toBeTruthy()
    expect((authority as { paneKey?: string }).paneKey ?? authority.agent?.paneKey).toBeTruthy()
  })

  // T3: anti-clobber. The adopted owner resolves to a DIFFERENT pane already holding H_old,
  // and this pty id is already published (registerPty ran for it earlier this generation).
  // H_old must survive untouched; the minted key's anchor must be gone; no warn (a real
  // anchor already exists at the destination).
  it('T3: redirect to a pane already holding an anchor leaves it untouched and rolls back the minted key, no warn', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn: async (args: {
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        preAllocatedHandle?: string
        agentSessionEnsure?: { claim: AgentSessionExecutionClaim }
      }) => ({
        id: NEW_PTY_ID,
        incarnationId: 'h2a-t3-incarnation',
        agentSessionEnsure: {
          disposition: 'adopted' as const,
          owner: {
            claim: args.agentSessionEnsure!.claim,
            generation: 'live-gen-1',
            phase: 'live' as const,
            ptyId: NEW_PTY_ID,
            surface: {
              worktreeId: WORKTREE_ID,
              // Redirect: the owner's real surface is the DESTINATION pane, not the one requested.
              tabId: DEST_TAB_ID,
              leafId: DEST_LEAF_ID,
              terminalHandle: 'term_h2a-t3-dest'
            }
          }
        }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    // Seed: this pty id was already published this generation (registerPty ran for it earlier),
    // and the destination pane already holds a genuine anchor (H_old) from that earlier launch.
    runtime.registerPty(NEW_PTY_ID, WORKTREE_ID, null, {
      tabId: DEST_TAB_ID,
      leafId: DEST_LEAF_ID,
      incarnationId: 'h2a-t3-incarnation',
      isReattach: true
    })
    const hOld = createHash('sha256').update('h-old-genuine-token').digest('hex')
    store!.persistTerminalLaunchTokenHash?.({
      tabId: DEST_TAB_ID,
      leafId: DEST_LEAF_ID,
      launchTokenHash: hOld
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[DEST_PANE_KEY]).toBe(hOld)

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'h2a-t3',
      agentSessionClaim: {
        digestVersion: 1,
        keyId: 'k1',
        identityDigest: 'd1',
        worktreeScopeDigest: 'w1',
        agent: 'claude'
      }
    })

    // H_old is byte-identical — never touched.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[DEST_PANE_KEY]).toBe(hOld)
    // The minted key's anchor is gone (rolled back — it had no prior anchor).
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    // No warn: the destination already had a genuine anchor.
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // T3b: redirect with NO destination anchor — nothing written under the destination, minted
  // key rolled back, exactly one warn.
  it('T3b: redirect to a pane with no anchor writes nothing at the destination and warns exactly once', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runtime.setPtyController({
      spawn: async (args: {
        env?: Record<string, string>
        tabId?: string
        leafId?: string
        preAllocatedHandle?: string
        agentSessionEnsure?: { claim: AgentSessionExecutionClaim }
      }) => ({
        id: NEW_PTY_ID,
        incarnationId: 'h2a-t3b-incarnation',
        agentSessionEnsure: {
          disposition: 'adopted' as const,
          owner: {
            claim: args.agentSessionEnsure!.claim,
            generation: 'live-gen-1',
            phase: 'live' as const,
            ptyId: NEW_PTY_ID,
            surface: {
              worktreeId: WORKTREE_ID,
              tabId: DEST_TAB_ID,
              leafId: DEST_LEAF_ID,
              terminalHandle: 'term_h2a-t3b-dest'
            }
          }
        }
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'h2a-t3b',
      agentSessionClaim: {
        digestVersion: 1,
        keyId: 'k1',
        identityDigest: 'd1',
        worktreeScopeDigest: 'w1',
        agent: 'claude'
      }
    })

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[DEST_PANE_KEY]).toBeUndefined()
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('redirected to a pane with no anchor')
    warnSpy.mockRestore()
  })

  // T4: persist-before-spawn. A throwing store must reject BEFORE the provider's spawn is ever
  // called. Must fail at fd0b4833d8 (createTerminal did not persist before spawn at all).
  it('T4: a throwing store rejects with launch_token_anchor_unavailable and never calls spawn', async () => {
    const { store, sessionSnapshot, setFlushFailuresRemaining } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let spawnCalled = false
    runtime.setPtyController({
      spawn: async () => {
        spawnCalled = true
        return { id: NEW_PTY_ID }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
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
        title: 'h2a-t4'
      })
    ).rejects.toThrow('launch_token_anchor_unavailable')
    expect(spawnCalled).toBe(false)
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
  })

  // T5: spawn-failure rollback. The minted key held H_old before this call; the spawn throws;
  // H_old must be restored.
  it('T5: a spawn failure restores the anchor the pane held before this call', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: async () => {
        throw new Error('simulated spawn failure')
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const hOld = createHash('sha256').update('h-old-genuine-token').digest('hex')
    store!.persistTerminalLaunchTokenHash?.({
      tabId: TAB_ID,
      leafId: LEAF_ID,
      launchTokenHash: hOld
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hOld)

    await expect(
      runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        credentialLane: { kind: 'shared' },
        command: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        tabId: TAB_ID,
        leafId: LEAF_ID,
        title: 'h2a-t5'
      })
    ).rejects.toThrow('simulated spawn failure')

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hOld)
  })
})
