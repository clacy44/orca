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
    },
    // Why real semantics matter: F1's revoke path and F4's null-relaunch path both call this to
    // clear a stale anchor — faking its storage medium is fine, faking its behavior would defeat
    // the test.
    forgetTerminalLaunchTokenHash: (paneKey: string) => {
      const { [paneKey]: _removed, ...rest } = session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = rest
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
      restoreProvenance: { kind: 'none' },
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

  it('F1: retirePtyAgentLaunchAuthority deletes the persisted anchor, so a revoked pane cannot corroborate its old token after a restart', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime1.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime1.attachWindow(1)
    runtime1.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime1.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
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
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(generation1Hash)

    // Regression baseline: before F1, the anchor survived retirement and still verified live.
    expect(runtime1.verifyLivePaneLaunchTokenHash(PANE_KEY, generation1Hash)).toBe(true)

    // The explicit revocation lever: command completion retires this pty's launch authority.
    runtime1.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })

    // F1: the persisted hash must be gone, not just the live pty.launchToken.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(runtime1.verifyLivePaneLaunchTokenHash(PANE_KEY, generation1Hash)).toBe(false)

    // End-to-end: even after a restart with no live pty, the retired token must never corroborate.
    const runtime2 = new OrcaRuntimeService(store)
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime2.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: GEN2_INCARNATION_ID,
      isReattach: true
    })
    expect(runtime2.verifyLivePaneLaunchTokenHash(PANE_KEY, generation1Hash)).toBe(false)
  })

  it('F2: a live connected pty holding a different (fresh cold-restore) token refuses the stale on-disk anchor without consulting it', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const staleToken = 'stale-previous-generation-token'
    const staleHash = createHash('sha256').update(staleToken).digest('hex')
    const freshToken = 'fresh-cold-restore-token'
    const freshHash = createHash('sha256').update(freshToken).digest('hex')

    // Seed the on-disk anchor as if a previous generation minted it for this pane.
    store?.persistTerminalLaunchTokenHash?.({
      tabId: TAB_ID,
      leafId: LEAF_ID,
      launchTokenHash: staleHash
    })
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(staleHash)

    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    // Cold restore into the existing pane mints a FRESH token on the live, connected pty —
    // the on-disk anchor still holds the previous generation's hash.
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: GEN2_INCARNATION_ID,
      agentLaunchAuthority: { launchToken: freshToken, launchAgent: 'claude' }
    })

    // The fresh, live token verifies.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, freshHash)).toBe(true)
    // F2: the stale on-disk anchor must NOT also verify while a live pty holds a different token.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, staleHash)).toBe(false)
  })

  it("F4: a null-token relaunch (plain shell) deletes the pane's previous anchor", async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
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
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(generation1Hash)

    // Relaunch the SAME pane as a plain shell — no launchToken this time.
    await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
      credentialLane: { kind: 'shared' },
      command: 'bash',
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'plain-shell'
    })

    // F4: the previous agent's anchor must not survive a null-token relaunch of the same pane.
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBeUndefined()
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, generation1Hash)).toBe(false)
  })

  // ── S10-13 regression: the daemon-survived restart ALWAYS mints a restored receipt ─────────
  // Field cert16803/cert16804 measured this exact state and got `no_pane_identity` while the
  // on-disk anchor was verifiably correct. Cause: the S10-10 gate above was scoped to the
  // no-receipt branch (`mintReceiptOnSuccess`), but a serve restart over a surviving daemon
  // reports the pty's ORIGINAL ORCA_TERMINAL_HANDLE and its UNCHANGED incarnationId, which makes
  // refreshPtyWorktreeRecordsWithControllerInventory take the exact-surface-restore branch and
  // mint a receipt for the pane — so `mintReceiptOnSuccess` was false and the anchor was never
  // consulted. The receipt branch has no early return of its own; it falls through to hook
  // attestation, which a restarted AgentHookServer cannot satisfy for a pane with no hydrated
  // commitment. This test drives the REAL restore sweep so the receipt is present, and asserts
  // the pane still attests from its genuine process-env token.
  it('S10-13: attests a daemon-survived pane whose restored receipt was minted by the real controller-inventory sweep', async () => {
    const { store, sessionSnapshot } = createSharedStore()
    const runtime1 = new OrcaRuntimeService(store)
    let capturedEnv: Record<string, string> | undefined
    runtime1.setPtyController(fakePtyController((env) => (capturedEnv = env)))
    runtime1.attachWindow(1)
    runtime1.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime1.createTerminal(`path:${WORKTREE_PATH}`, {
      restoreProvenance: { kind: 'none' },
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
    expect(sessionSnapshot().terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(generation1Hash)

    // The surface bindings a real restart reads back off disk: tab -> pty, layout leaf -> pty, and
    // the pane's incarnation. Together with a controller session reporting the SAME incarnationId
    // these are exactly the `restoresExactSurface && controllerIdentity` preconditions that make
    // the sweep mint a restored receipt.
    const session = sessionSnapshot()
    session.tabsByWorktree = {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'anchor-agent',
          defaultTitle: 'anchor-agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    } as WorkspaceSessionState['tabsByWorktree']
    session.terminalLayoutsByTabId = {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    } as WorkspaceSessionState['terminalLayoutsByTabId']
    session.terminalPtyIncarnationsByPaneKey = { [PANE_KEY]: GEN2_INCARNATION_ID }

    // ── Restart: fresh runtime + fresh hook server (nothing hydrated from disk) ───────────────
    agentHookServer = new AgentHookServer()
    await agentHookServer.start({ env: 'production' })
    const runtime2 = new OrcaRuntimeService(store, undefined, {
      attestAgentHookCompatibilityAuthority: (candidate) =>
        agentHookServer!.attestCompatibilityAuthority(candidate)
    })
    runtime2.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    // The surviving daemon reports the pane's ORIGINAL exported handle and unchanged incarnation.
    runtime2.setPtyController({
      ...fakePtyController(() => {}),
      listProcesses: async () => [
        {
          id: PTY_ID,
          incarnationId: GEN2_INCARNATION_ID,
          cwd: WORKTREE_PATH,
          title: 'anchor-agent',
          worktreeId: WORKTREE_ID,
          terminalHandle: RESTORED_TERMINAL_HANDLE
        }
      ]
    } as Parameters<typeof runtime2.setPtyController>[0])

    await runtime2.refreshRestoredOrchestrationAuthority(null)

    // Proves the sweep took the receipt-minting branch: the controller handle was adopted
    // (controllerIdentity present) AND the persisted pane surface was restored onto the pty
    // (restoresExactSurface) — that conjunction is exactly what mints the restored receipt.
    const dispatch = runtime2.getOrchestrationDispatchAuthority(RESTORED_TERMINAL_HANDLE)
    expect(dispatch?.ptyId).toBe(PTY_ID)
    expect(dispatch?.paneKey).toBe(PANE_KEY)
    // A daemon-survived pty never regains its launch token — the anchor is the only proof left.
    expect(dispatch?.launchTokenHash).toBeNull()
    // The hook lane genuinely cannot help here: nothing hydrated, so attestation must refuse.
    expect(agentHookServer.getHydratedAuthorityCommitments()).toHaveLength(0)

    // ── Acceptance: the genuine process-env token attests through the anchor ─────────────────
    expect(
      runtime2.verifyOrchestrationCompatibilityCaller({
        terminalHandle: RESTORED_TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: generation1Token!
      })
    ).toMatchObject({
      paneKey: PANE_KEY,
      terminalHandle: RESTORED_TERMINAL_HANDLE,
      launchTokenHash: generation1Hash
    })

    // Negative controls — the receipt must not become a bypass for the token itself.
    expect(
      runtime2.verifyOrchestrationCompatibilityCaller({
        terminalHandle: RESTORED_TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: 'attacker-chosen-token'
      })
    ).toBeNull()
    expect(
      runtime2.verifyOrchestrationCompatibilityCaller({
        terminalHandle: RESTORED_TERMINAL_HANDLE,
        paneKey: makePaneKey('tab-unrelated', LEAF_ID),
        launchToken: generation1Token!
      })
    ).toBeNull()
  })
})
