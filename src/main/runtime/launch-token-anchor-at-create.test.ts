// H2c (F-6d, Ruling 32 Addendum 7): the anchor is written iff the process at the final pane
// holds the token minted by THIS create. The fact rides on the owner record's launchTokenHash
// (claimed-agent-pty-owner.ts, set at creation from the caller's spawn env) — never on
// disposition, provider-result nullness, or spawnPublishedPtys membership (H2a's vetoed
// `ptyPreexisted`/`tokenGenuinelyDelivered`; 60ca5eef17's dead `launchTokenDelivered` stays
// removed too).
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

const REPO_ID = 'repo-h2c'
const REPO_PATH = '/tmp/repo-h2c'
const WORKTREE_PATH = '/tmp/worktree-h2c'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): createTerminal's workspace-selector resolution shells out to
// `git worktree list`; this suite is about the anchor/gate correctness, not git plumbing.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-h2c',
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

const TAB_ID = 'tab-h2c'
const LEAF_ID = '77777777-7777-4777-8777-777777777777'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const NEW_PTY_ID = 'pty-h2c-new-1'

/** A minimal but faithful stand-in for persistence.ts's PersistenceStore: real read/write
 *  semantics for the members this ticket touches. */
function createSharedStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  sessionSnapshot: () => WorkspaceSessionState
} {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    terminalLaunchTokenHashesByPaneKey: {}
  }
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      { id: REPO_ID, path: REPO_PATH, displayName: 'h2c-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'h2c',
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
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [makePaneKey(args.tabId, args.leafId)]: args.launchTokenHash
      }
    },
    forgetTerminalLaunchTokenHash: (paneKey: string) => {
      const { [paneKey]: _removed, ...rest } = session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = rest
    },
    isWritesFrozen: () => false
  }
  return { store, sessionSnapshot: () => session }
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
  const parsed = m.params ? m.params.parse({ name: `h2c-agent-${Date.now()}` }) : undefined
  const ctx: RpcContext = { runtime, orchestrationCompatibilityEvidence: evidence }
  return m.handler(parsed, ctx)
}

function getPtyLaunchToken(runtime: OrcaRuntimeService, ptyId: string): string | null {
  const internals = runtime as unknown as {
    getOrCreatePtyWorktreeRecord: (id: string) => { launchToken: string | null } | null
  }
  return internals.getOrCreatePtyWorktreeRecord(ptyId)?.launchToken ?? null
}

const claimFor = (agent: 'claude' | 'codex' = 'claude'): AgentSessionExecutionClaim => ({
  digestVersion: 1,
  keyId: 'k1',
  identityDigest: 'd1',
  worktreeScopeDigest: 'w1',
  agent
})

describe('H2c (F-6d, Ruling 32 Addendum 7): launch-token anchor at create', () => {
  let db: OrchestrationDb | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  // T2': field repro with a FAITHFUL fake ptyController — its spawn calls registerPty for the
  // NEW id BEFORE returning (pty.ts's real adopted branch does this too, at ~5219-5231), and the
  // owner it reports carries the hash of the SAME env this call spawned with. Must fail at
  // 05fbffd630: H2a's gate there disqualifies this exact shape via `ptyPreexisted` (the pty was
  // already published by the time the parent checks spawnPublishedPtys).
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
        const token = args.env?.ORCA_AGENT_LAUNCH_TOKEN
        // Faithful to pty.ts ~5219-5231: registerPty runs for the new id INSIDE the adopted
        // branch, before it returns.
        runtime.registerPty(NEW_PTY_ID, WORKTREE_ID, null, {
          tabId: args.tabId!,
          leafId: args.leafId!,
          incarnationId: 'h2c-t2-incarnation',
          isReattach: true
        })
        return {
          id: NEW_PTY_ID,
          incarnationId: 'h2c-t2-incarnation',
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
              },
              launchTokenHash: token ? createHash('sha256').update(token).digest('hex') : undefined
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
      title: 'h2c-t2',
      agentSessionClaim: claimFor()
    })

    const token = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(token).toBeTruthy()
    const hash = createHash('sha256').update(token!).digest('hex')

    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hash)
    expect(getPtyLaunchToken(runtime, NEW_PTY_ID)).toBe(token)

    const authority = (await callRegister(runtime, {
      terminalHandle: terminal.handle,
      paneKey: PANE_KEY,
      launchToken: token!
    })) as { agent?: { paneKey?: string } }
    expect(authority).toBeTruthy()
    expect((authority as { paneKey?: string }).paneKey ?? authority.agent?.paneKey).toBeTruthy()
  })

  // T3': attach-only adopt of a pre-existing pane. The owner's stored launchTokenHash belongs
  // to a DIFFERENT (or no) create — this call's own minted token was never delivered to that
  // process. H_old must survive untouched; nothing is written; pty.launchToken stays unset;
  // exactly one warn.
  it.each([
    ['a mismatched hash', () => 'f'.repeat(64)],
    ['no hash at all', () => undefined]
  ])(
    'T3: %s on the owner leaves the anchor untouched and warns exactly once',
    async (_label, ownerHash) => {
      const { store, sessionSnapshot } = createSharedStore()
      const runtime = new OrcaRuntimeService(store)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      runtime.setPtyController({
        spawn: async (args: {
          tabId?: string
          leafId?: string
          preAllocatedHandle?: string
          agentSessionEnsure?: { claim: AgentSessionExecutionClaim }
        }) => ({
          id: NEW_PTY_ID,
          incarnationId: 'h2c-t3-incarnation',
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
              },
              launchTokenHash: ownerHash()
            }
          }
        }),
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

      await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
        credentialLane: { kind: 'shared' },
        command: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
        tabId: TAB_ID,
        leafId: LEAF_ID,
        title: 'h2c-t3',
        agentSessionClaim: claimFor()
      })

      expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(hOld)
      expect(getPtyLaunchToken(runtime, NEW_PTY_ID)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('does not hold it')
      warnSpy.mockRestore()
    }
  )
})
