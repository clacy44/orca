// F-6d (H2, Ruling 32a): the residual corner of Ruling 11(d)/S10-17 (s10-17-attestation-anchor
// test.ts) that field-run-10i found — a resume-adopt (agentSessionEnsure.disposition ===
// 'adopted') whose underlying spawn DID run and DID deliver ORCA_AGENT_LAUNCH_TOKEN into the
// process env (unlike S10-17's F5, a genuine daemon-survived/no-real-spawn adoption) was still
// treated as "nothing to record" by orca-runtime.ts:28038's blanket `!resumedLiveAgentSession`
// guard, leaving a live, token-bearing pane with no route to authority (pty.ts:5067's
// `launchTokenDelivered` bit fixes this). Kept in its own file (not appended to
// s10-17-attestation-anchor.test.ts) to stay under the max-lines ratchet.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import type { RpcContext } from './rpc/core'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-f6d'
const REPO_PATH = '/tmp/repo-f6d'
const WORKTREE_PATH = '/tmp/worktree-f6d'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-f6d',
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

const TAB_ID = 'tab-f6d'
const LEAF_ID = '99999999-9999-4999-8999-999999999999'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-f6d-1'

function orchestrationMethod(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

async function callOrchestration(
  name: string,
  params: Record<string, unknown>,
  context: RpcContext
) {
  const m = orchestrationMethod(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  return m.handler(parsed, context)
}

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
      { id: REPO_ID, path: REPO_PATH, displayName: 'f6d-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'f6d',
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

/** Models the shape of an agentSessionEnsure "adopted" spawn result (pty.ts:5030-5074). */
function adoptedSpawnResult(args: {
  agentSessionEnsure: { claim: AgentSessionExecutionClaim }
  tabId: string
  leafId: string
  preAllocatedHandle: string
  launchTokenDelivered?: boolean
}): {
  id: string
  launchTokenDelivered?: boolean
  agentSessionEnsure: {
    disposition: 'adopted'
    owner: {
      claim: AgentSessionExecutionClaim
      generation: string
      phase: 'live'
      ptyId: string
      surface: { worktreeId: string; tabId: string; leafId: string; terminalHandle: string }
    }
  }
} {
  return {
    id: PTY_ID,
    ...(args.launchTokenDelivered !== undefined
      ? { launchTokenDelivered: args.launchTokenDelivered }
      : {}),
    agentSessionEnsure: {
      disposition: 'adopted' as const,
      owner: {
        claim: args.agentSessionEnsure.claim,
        generation: 'live-gen-1',
        phase: 'live' as const,
        ptyId: PTY_ID,
        surface: {
          worktreeId: WORKTREE_ID,
          tabId: args.tabId,
          leafId: args.leafId,
          terminalHandle: args.preAllocatedHandle
        }
      }
    }
  }
}

const AGENT_SESSION_CLAIM: AgentSessionExecutionClaim = {
  digestVersion: 1,
  keyId: 'k1',
  identityDigest: 'd1',
  worktreeScopeDigest: 'w1',
  agent: 'claude'
}

describe('F-6d (H2, Ruling 32a): resume-adopt launch-token delivery', () => {
  it('a resume-adopted spawn whose env carried the token records the anchor and registers through the real handler', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(new OrchestrationDb(':memory:'))
    const spawnCalls: { env?: Record<string, string>; agentSessionEnsure?: unknown }[] = []
    runtime.setPtyController({
      spawn: async (args) => {
        spawnCalls.push(args)
        if (args.agentSessionEnsure) {
          // pty.ts proves a REAL spawn ran (providerResult non-null) and its env carried the
          // token — distinct from the daemon-survived/no-real-spawn corner (S10-17 F5), which
          // reports no launchTokenDelivered bit at all.
          return adoptedSpawnResult({
            agentSessionEnsure: args.agentSessionEnsure as { claim: AgentSessionExecutionClaim },
            tabId: args.tabId!,
            leafId: args.leafId!,
            preAllocatedHandle: args.preAllocatedHandle!,
            launchTokenDelivered: true
          })
        }
        return { id: PTY_ID }
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
      title: 'agent-resume-delivered',
      agentSessionClaim: AGENT_SESSION_CLAIM
    })

    const deliveredToken = spawnCalls[0]?.env?.ORCA_AGENT_LAUNCH_TOKEN
    expect(deliveredToken).toBeTruthy()
    const deliveredHash = createHash('sha256').update(deliveredToken!).digest('hex')
    // D1 fix: unlike S10-17's F5 (no launchTokenDelivered), this resume-adopt DID prove
    // delivery, so the anchor must be recorded, not skipped.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(deliveredHash)

    // Through the REAL register handler with the REAL (unmocked) verifier: a pane the runtime
    // never recorded a token for could never attest (F-6d's field symptom); this pane must.
    const registered = (await callOrchestration(
      'orchestration.agents.register',
      { name: 'resume-delivered-agent', role: 'test agent' },
      {
        runtime,
        orchestrationCompatibilityEvidence: {
          terminalHandle: terminal.handle,
          paneKey: PANE_KEY,
          launchToken: deliveredToken
        }
      }
    )) as { agent: { id: string; displayName: string } }
    expect(registered.agent.displayName).toBe('resume-delivered-agent')
  })

  it('a resume-adopt that did NOT prove delivery warns instead of silently dropping the minted token', async () => {
    const { store } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runtime.setPtyController({
        spawn: async (args) => {
          if (args.agentSessionEnsure) {
            // Same disposition as S10-17's F5 — no launchTokenDelivered — the case that must
            // stay silent on delivery (no anchor write) but LOUD in the log (D1 belt).
            return adoptedSpawnResult({
              agentSessionEnsure: args.agentSessionEnsure as { claim: AgentSessionExecutionClaim },
              tabId: args.tabId!,
              leafId: args.leafId!,
              preAllocatedHandle: args.preAllocatedHandle!
            })
          }
          return { id: PTY_ID }
        },
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
        title: 'agent-resume-undelivered',
        agentSessionClaim: AGENT_SESSION_CLAIM
      })

      expect(warnSpy).toHaveBeenCalledWith(
        '[runtime] createTerminal: launch token minted but not recorded for resume-adopted pane',
        expect.objectContaining({ paneKey: PANE_KEY })
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
