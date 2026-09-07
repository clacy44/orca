// S10-10 adversarial-review follow-ups (F3, F5, F7, F8): regression tests for the review findings
// that fell outside s10-10-restored-launch-token-anchor.test.ts's end-to-end createTerminal harness.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const WORKTREE_ID = 'repo-findings::/tmp/worktree-findings'
const TAB_ID = 'tab-findings'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const PTY_ID = 'pty-findings-1'
const SSH_CONNECTION_ID = 'ssh-target-findings'
const SSH_HOST_ID = toSshExecutionHostId(SSH_CONNECTION_ID)

/** Multi-host-aware fake store: real per-hostId partitioning, unlike the single-session fake in
 *  s10-10-restored-launch-token-anchor.test.ts, because F5 is specifically about partition
 *  selection across hosts. */
function createMultiHostStore(): {
  store: ConstructorParameters<typeof OrcaRuntimeService>[0]
  sessionSnapshot: (hostId?: string) => WorkspaceSessionState
} {
  const sessions = new Map<string, WorkspaceSessionState>()
  const getSession = (hostId?: string | null): WorkspaceSessionState => {
    const key = hostId ?? LOCAL_EXECUTION_HOST_ID
    let session = sessions.get(key)
    if (!session) {
      session = {
        ...getDefaultWorkspaceSession(),
        terminalLaunchTokenHashesByPaneKey: {},
        terminalLaunchTokenAnchorPtyByPaneKey: {}
      }
      sessions.set(key, session)
    }
    return session
  }
  const store = {
    getRepo: () => undefined,
    getRepos: () => [],
    addRepo: () => {},
    updateRepo: () => undefined as never,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
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
    getWorkspaceSession: (hostId?: string | null) => getSession(hostId),
    persistTerminalLaunchTokenHash: (
      args: {
        tabId: string
        leafId: string
        launchTokenHash: string
        anchorPty?: string | null
      },
      hostId?: string | null
    ) => {
      const session = getSession(hostId)
      const paneKey = makePaneKey(args.tabId, args.leafId)
      session.terminalLaunchTokenHashesByPaneKey = {
        ...session.terminalLaunchTokenHashesByPaneKey,
        [paneKey]: args.launchTokenHash
      }
      // S10-21c S1: the hash and its pty binding are one write, per partition.
      if (args.anchorPty) {
        session.terminalLaunchTokenAnchorPtyByPaneKey = {
          ...session.terminalLaunchTokenAnchorPtyByPaneKey,
          [paneKey]: args.anchorPty
        }
        return
      }
      const { [paneKey]: _unbound, ...restBindings } =
        session.terminalLaunchTokenAnchorPtyByPaneKey ?? {}
      session.terminalLaunchTokenAnchorPtyByPaneKey = restBindings
    },
    forgetTerminalLaunchTokenHash: (paneKey: string, hostId?: string | null) => {
      const session = getSession(hostId)
      const { [paneKey]: _removed, ...rest } = session.terminalLaunchTokenHashesByPaneKey ?? {}
      session.terminalLaunchTokenHashesByPaneKey = rest
      const { [paneKey]: _removedBinding, ...restBindings } =
        session.terminalLaunchTokenAnchorPtyByPaneKey ?? {}
      session.terminalLaunchTokenAnchorPtyByPaneKey = restBindings
    }
  }
  return { store, sessionSnapshot: (hostId?: string) => getSession(hostId) }
}

describe('S10-10 review findings: F3/F5/F7/F8', () => {
  it('F5: the anchor partition comes from the explicit connectionId argument, not from any live pty state', () => {
    const { store } = createMultiHostStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const localHash = createHash('sha256').update('local-token').digest('hex')
    const sshHash = createHash('sha256').update('ssh-token').digest('hex')
    // [S10-21c S1] The anchor is only honoured while the pty it was minted for stands on the pane,
    // so each partition's anchor names a pty LIVE IN THAT SAME PARTITION.
    // [S10-21c B1b, D-R146 INFO — adopted hardening] The identity conjunct's live-pty scan now
    // also refuses a pty whose own partition differs from the hostId the anchor was read from, so
    // this fixture registers ONE pty per partition under test (a single local pty satisfying both
    // used to be enough; it is what the hardening exists to refuse).
    const PTY_ID_SSH = 'pty-findings-1-ssh'
    const anchorPtyLocal = `${PTY_ID}:findings-incarnation-f5`
    const anchorPtySsh = `${PTY_ID_SSH}:findings-incarnation-f5-ssh`
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'findings-incarnation-f5',
      isReattach: true
    })
    runtime.registerPty(PTY_ID_SSH, WORKTREE_ID, SSH_CONNECTION_ID, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'findings-incarnation-f5-ssh',
      isReattach: true
    })
    store?.persistTerminalLaunchTokenHash?.(
      { tabId: TAB_ID, leafId: LEAF_ID, launchTokenHash: localHash, anchorPty: anchorPtyLocal },
      undefined
    )
    store?.persistTerminalLaunchTokenHash?.(
      { tabId: TAB_ID, leafId: LEAF_ID, launchTokenHash: sshHash, anchorPty: anchorPtySsh },
      SSH_HOST_ID
    )

    // The caller's own connectionId claim must select the partition, not a live-pty inference.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, localHash, null)).toBe(true)
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, sshHash, null)).toBe(false)
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, sshHash, SSH_CONNECTION_ID)).toBe(true)
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, localHash, SSH_CONNECTION_ID)).toBe(
      false
    )
  })

  // [S10-21c B1b, D-R146 INFO — adopted hardening] Cross-partition looseness: the identity
  // conjunct's live-pty scan must not let a LOCAL pty on the same paneKey satisfy an SSH-partition
  // anchor.
  it('D-R146 INFO: an SSH-partition anchor is NOT satisfied by a local pty on the same paneKey', () => {
    const { store } = createMultiHostStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    // Only a LOCAL pty stands on this pane. The SSH partition's anchor names that same
    // local pty's identity — a misconfiguration/attacker shape, not a legitimate mint.
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'findings-incarnation-cross-partition',
      isReattach: true
    })
    const localPtyIdentity = `${PTY_ID}:findings-incarnation-cross-partition`
    const sshHash = createHash('sha256').update('cross-partition-ssh-token').digest('hex')
    store?.persistTerminalLaunchTokenHash?.(
      { tabId: TAB_ID, leafId: LEAF_ID, launchTokenHash: sshHash, anchorPty: localPtyIdentity },
      SSH_HOST_ID
    )

    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, sshHash, SSH_CONNECTION_ID)).toBe(false)
  })

  // S10-10 closeout (F1 residual): in a RESTORED generation the pty has neither a live
  // launchToken nor a receipt — the old early return skipped the anchor delete for exactly
  // that population, leaving the revocation lever dead where it matters most. Mutation guard:
  // moving the forget call back below the early return turns this red.
  it('F1 residual: retiring launch authority in a restored generation still deletes the persisted anchor', () => {
    const { store, sessionSnapshot } = createMultiHostStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    // Generation-1 leftover: anchor on disk; generation-2 pty restored WITHOUT a token or receipt.
    const staleHash = createHash('sha256').update('generation-1-token').digest('hex')
    store?.persistTerminalLaunchTokenHash?.(
      {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        launchTokenHash: staleHash,
        // Generation 1's pty, which is gone — this generation's pty is a different one.
        anchorPty: `${PTY_ID}:restored-gen-1`
      },
      undefined
    )
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'restored-gen-2'
      // no agentLaunchAuthority: restored pty, launchToken null, no receipt
    })
    expect(sessionSnapshot(undefined).terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(
      staleHash
    )

    ;(
      runtime as unknown as {
        retirePtyAgentLaunchAuthority(ptyId: string, reason: 'command_finished' | 'pty_exit'): void
      }
    )
      // [S10-21c S1] The reason names the lever: a real pty exit is what deletes the anchor.
      .retirePtyAgentLaunchAuthority(PTY_ID, 'pty_exit')

    expect(
      sessionSnapshot(undefined).terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]
    ).toBeUndefined()
    // And the retired hash no longer corroborates through the anchor fallback.
    expect(runtime.verifyLivePaneLaunchTokenHash(PANE_KEY, staleHash, null)).toBe(false)
  })

  it("F3: registerPty's renderer-owned agentLaunchAuthority path persists the anchor too", () => {
    const { store, sessionSnapshot } = createMultiHostStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const launchToken = 'renderer-owned-launch-token'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    runtime.registerPty(PTY_ID, WORKTREE_ID, SSH_CONNECTION_ID, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'findings-incarnation-1',
      agentLaunchAuthority: { launchToken, launchAgent: 'claude' }
    })

    expect(sessionSnapshot(SSH_HOST_ID).terminalLaunchTokenHashesByPaneKey?.[PANE_KEY]).toBe(
      launchTokenHash
    )
  })

  it('F8: a flushOrThrow failure at the registerPty persist site does not throw out of registerPty', () => {
    const { store } = createMultiHostStore()
    store!.persistTerminalLaunchTokenHash = () => {
      throw new Error('simulated disk failure')
    }
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        incarnationId: 'findings-incarnation-2',
        agentLaunchAuthority: { launchToken: 'some-token', launchAgent: 'claude' }
      })
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('F7: verifyOrchestrationCompatibilityCaller mints the receipt/authority under terminal.paneKey, not an attacker-claimed paneKey', () => {
    const { store } = createMultiHostStore()
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    // Restored pane, no receipt: registerPty with NO agentLaunchAuthority puts this on the
    // no-receipt/mintReceiptOnSuccess branch verifyOrchestrationCompatibilityCaller uses.
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'findings-incarnation-3',
      isReattach: true
    })
    runtime.registerPreAllocatedHandleForPty(PTY_ID, 'term_findings-restored')
    // Seed a persisted anchor as though this runtime minted it earlier for THIS paneKey.
    const genuineToken = 'genuine-restored-token'
    const genuineHash = createHash('sha256').update(genuineToken).digest('hex')
    store?.persistTerminalLaunchTokenHash?.(
      {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        launchTokenHash: genuineHash,
        anchorPty: `${PTY_ID}:findings-incarnation-3`
      },
      undefined
    )

    const authority = runtime.verifyOrchestrationCompatibilityCaller({
      terminalHandle: 'term_findings-restored',
      paneKey: PANE_KEY,
      launchToken: genuineToken
    })
    // F7: the frozen authority's paneKey is terminal.paneKey (verified live), not merely the
    // caller-claimed paneKey string echoed back unchecked.
    expect(authority).toMatchObject({ paneKey: PANE_KEY })
  })
})
