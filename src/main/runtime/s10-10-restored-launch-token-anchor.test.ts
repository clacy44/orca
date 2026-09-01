// S10-10: end-to-end proof that the persisted launch-token-hash anchor closes the gap S10-6 left
// open — a daemon-survived pty has NO launchToken in its runtime record after a restart (only the
// agent's own process env still holds it), so the S10-6 corroboration gate (isCorroboratedAuthority
// in server.ts) could neither verify it against a live pty nor find continuity with an
// already-persisted commitment. A pane whose commitment was never on disk before the restart could
// then never establish one, ever, from genuine hook activity (PROOF on the box: last-status.json
// had 3 status entries but only 1 authorityCommitment).
//
// This suite reproduces the field scenario against REAL (unmocked) OrcaRuntimeService +
// AgentHookServer instances:
//   generation 1: a real createTerminal() launch mints a launchToken and persists its sha256,
//     keyed by paneKey, into the (fake, but faithfully-behaved) workspace-session store.
//   restart: a FRESH runtime instance registers the same ptyId via the real registerPty() path
//     with NO launchToken, NO restored receipt, and a FRESH AgentHookServer with NO hydrated
//     commitment for the pane (no userDataPath — nothing to hydrate from).
//   the agent's own process env (captured from generation 1's real spawn call) still holds the
//     genuine token — exactly what a real hook script would present.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-anchor'
const REPO_PATH = '/tmp/repo-anchor'
const WORKTREE_PATH = '/tmp/worktree-anchor'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

// Why mocked (not real fs/git): createTerminal's workspace-selector resolution shells out to
// `git worktree list` via listWorktrees — this suite is about the runtime/hook-server authority
// chain, not git plumbing, so it stands in a single resolved worktree exactly as
// orca-runtime.test.ts does for its own non-git-focused cases. Why `vi.hoisted`: `vi.mock`'s
// factory is hoisted above every top-level const, so the mocked worktree path is inlined here.
const MOCK_GIT_WORKTREES = vi.hoisted(() => [
  {
    path: '/tmp/worktree-anchor',
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
const TAB_ID = 'tab-anchor'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-anchor-1'
const RESTORED_TERMINAL_HANDLE = 'term_restored-anchor-1'
const GEN2_INCARNATION_ID = 'anchor-incarnation-gen2'

/** A minimal but faithful stand-in for persistence.ts's PersistenceStore: real read/write
 *  semantics for the two members this ticket touches (persistTerminalLaunchTokenHash /
 *  getWorkspaceSession), shared across two OrcaRuntimeService instances the way the same on-disk
 *  session survives a real restart. Everything else is the minimum createTerminal needs. */
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
      { id: REPO_ID, path: REPO_PATH, displayName: 'anchor-repo', badgeColor: 'blue', addedAt: 1 }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({ ...store.getRepo(id), ...updates }) as never,
    getAllWorktreeMeta: () => ({
      [WORKTREE_ID]: {
        displayName: 'anchor',
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
    // Why real semantics matter: this is the exact method createTerminal calls at mint (A1) and
    // verifyLivePaneLaunchTokenHash reads back on restore (A2) — faking its storage medium is
    // fine, faking its behavior would defeat the test.
    persistTerminalLaunchTokenHash: (args: {
      tabId: string
      leafId: string
      launchTokenHash: string
    }) => {
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [makePaneKey(args.tabId, args.leafId)]: args.launchTokenHash
      }
    }
  }
  return { store, sessionSnapshot: () => session }
}

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

describe('S10-10 persisted launch-token anchor: restored pane end-to-end', () => {
  let agentHookServer: AgentHookServer | null = null

  afterEach(() => {
    agentHookServer?.stop()
    agentHookServer = null
  })

  it('lets a daemon-survived pane corroborate and attest from its genuine process-env token, with no receipt and no hydrated commitment', async () => {
    // ── Generation 1: real launch mints the token and persists its hash (A1) ──────────────
    const { store, sessionSnapshot } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime1.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime1.attachWindow(1)
    runtime1.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime1.createTerminal(`path:${WORKTREE_PATH}`, {
      credentialLane: { kind: 'shared' },
      command: 'claude',
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'anchor-agent'
    })

    const generation1Token = capturedEnv?.ORCA_AGENT_LAUNCH_TOKEN
    expect(generation1Token).toBeTruthy()
    const generation1Hash = createHash('sha256').update(generation1Token!).digest('hex')

    // Proves A1: the hash (never the token) reached the shared store from the real launch path.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(generation1Hash)
    expect(JSON.stringify(sessionSnapshot())).not.toContain(generation1Token!)

    // ── Restart: fresh runtime, fresh hook server ─────────────────────────────────────────
    // Restored pty: registered via the real registerPty() path with NO agentLaunchAuthority, so
    // pty.launchToken stays null — exactly the field-confirmed shape. No restored receipt exists
    // (fresh restoredOrchestrationAuthorityByPtyId) and the hook server has no userDataPath, so it
    // hydrates nothing from disk — NO hydrated commitment for this pane either.
    agentHookServer = new AgentHookServer()
    await agentHookServer.start({ env: 'production' })
    const runtime2 = new OrcaRuntimeService(store, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) =>
        agentHookServer!.attestCompatibilityAuthority(candidate)
    })
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: GEN2_INCARNATION_ID,
      isReattach: true
    })
    runtime2.registerPreAllocatedHandleForPty(PTY_ID, RESTORED_TERMINAL_HANDLE)
    agentHookServer.setPaneLaunchAuthorityVerifier((paneKey, launchTokenHash) =>
      runtime2.verifyLivePaneLaunchTokenHash(paneKey, launchTokenHash)
    )

    // ── A2 unit-level proof: the anchor alone corroborates the genuine token ─────────────
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, generation1Hash)).toBe(true)
    // Negative control: a different/self-chosen token for the SAME paneKey must still refuse.
    expect(
      runtime2.verifyLivePaneLaunchTokenHash(
        PANE_KEY,
        createHash('sha256').update('attacker-chosen-token').digest('hex')
      )
    ).toBe(false)
    // Negative control: another (unrelated, never-launched) pane's key has no persisted hash and
    // no commitment — the true unknown pane — and must refuse even for the real token's hash.
    expect(
      runtime2.verifyLivePaneLaunchTokenHash(makePaneKey('tab-unrelated', LEAF_ID), generation1Hash)
    ).toBe(false)

    // ── A2/server: a genuine hook POST corroborates and persists a commitment ────────────
    const env = agentHookServer.buildPtyEnv()
    const postHook = (launchToken: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN!
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          launchToken,
          env: 'production',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'resumed after restart' }
        })
      })

    const hookRes = await postHook(generation1Token!)
    expect(hookRes.status).toBe(204)
    expect(agentHookServer.getCurrentAuthorityObservations()).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, launchTokenHash: generation1Hash })
    ])

    // ── Negative control at the hook-server layer: a forged token for this pane must not
    // displace or coexist with the corroborated observation. ────────────────────────────────
    const forgedRes = await postHook('attacker-chosen-token')
    expect(forgedRes.status).toBe(204)
    expect(agentHookServer.getCurrentAuthorityObservations()).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, launchTokenHash: generation1Hash })
    ])

    // ── A3 acceptance bar: the attested verb succeeds end to end ─────────────────────────
    const authority = runtime2.verifyOrchestrationCompatibilityCaller({
      terminalHandle: RESTORED_TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      launchToken: generation1Token!
    })
    expect(authority).toMatchObject({
      paneKey: PANE_KEY,
      terminalHandle: RESTORED_TERMINAL_HANDLE,
      launchTokenHash: generation1Hash
    })

    // Negative control: a self-chosen token for this same, now-live pane must still refuse.
    expect(
      runtime2.verifyOrchestrationCompatibilityCaller({
        terminalHandle: RESTORED_TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: 'attacker-chosen-token'
      })
    ).toBeNull()
    // Negative control: another pane's genuine token against THIS paneKey must still refuse —
    // there is no live pty and no persisted hash for a mismatched pane/token pairing.
    expect(
      runtime2.verifyOrchestrationCompatibilityCaller({
        terminalHandle: RESTORED_TERMINAL_HANDLE,
        paneKey: makePaneKey('tab-unrelated', LEAF_ID),
        launchToken: generation1Token!
      })
    ).toBeNull()
  })
})
