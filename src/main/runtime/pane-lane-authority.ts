import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type {
  PersistedPaneCredentialLane,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import {
  PaneCredentialLaneRegistry,
  type PaneCredentialLane,
  type PaneCredentialLaneLookup
} from './pane-credential-lane-registry'
import { resolveInheritedLane } from './terminal-inherited-lane-authority'
import {
  SHARED_CREDENTIAL_LANE,
  resolveCallerCredentialLane,
  type PrincipalLookup
} from './terminal-credential-lane-resolution'

/** The pane a lane question is asked about, as the runtime can see it. */
export type PaneLaneSurface = {
  worktreeId: string
  paneKey: string
  /** Set for an SSH/relay pane: `remote`, and never lane-bound (§2a). */
  connectionId?: string | null
}

export type PaneLaneAuthorityDeps = {
  /** A renderer leaf under this pane identity — the pane exists with no PTY of its own. */
  rendererLeafExists(tabId: string, leafId: string): boolean
  /** paneKeys of the live PTYs; a pane backing one is known however it was minted. */
  livePtyPaneKeys(): Iterable<string>
  /** The persisted session partition a worktree belongs to, before any pane spawns. */
  workspaceSessionOf(worktreeId: string): WorkspaceSessionState | null
  /** The published mobile-session snapshot: a pending tab lives only here until it spawns. */
  mobileSessionTabsOf(worktreeId: string): RuntimeMobileSessionTabsSnapshot | null
  /** The pane a live PTY runs in, for the `inherit` edges that name a PTY. */
  paneOfPty(ptyId: string): PaneLaneSurface | null
  readPersistedLanes(): Record<string, PersistedPaneCredentialLane> | null
  persistLane(row: {
    worktreeId: string
    tabId: string
    leafId: string
    principalId?: string
  }): void
}

/**
 * An SSH/relay pane is `remote` and never lane-bound, so `connectionId` is a condition of the
 * lane *value* and not merely of where its row is filed (§2a).
 *
 * Without it a lane holder's `terminal.create` against an SSH-backed workspace stamps their
 * principal onto a pane whose process can only ever run on the remote host: the spawn anchor then
 * either refuses a legitimate remote terminal or exports a host lane path into an SSH env.
 */
export function laneForPaneConnection(
  lane: PaneCredentialLane,
  connectionId?: string | null
): PaneCredentialLane {
  return connectionId ? SHARED_CREDENTIAL_LANE : lane
}

/**
 * Every pane→lane decision the runtime makes, in one place (S9 §2a/§2h).
 *
 * It owns the binding table, the pane-surface probe the adopt gate reads, the `inherit` edges and
 * the two refusals that have no source pane to read — so `orca-runtime.ts` holds delegating calls
 * and none of the decisions.
 */
export class PaneLaneAuthority {
  private readonly registry = new PaneCredentialLaneRegistry()
  private rehydrated = false
  private principals: PrincipalLookup | null = null

  constructor(private readonly deps: PaneLaneAuthorityDeps) {}

  /** Lanes reach the funnel only through the host consent surface; with no lookup all is shared. */
  setPrincipalLookup(lookup: PrincipalLookup | null): void {
    this.principals = lookup
    this.rehydrated = false
  }

  callerLane(pairedDeviceId?: string | null): PaneCredentialLane {
    return resolveCallerCredentialLane(pairedDeviceId, this.principals)
  }

  private ensureRehydrated(): void {
    if (this.rehydrated) {
      return
    }
    const rows = this.deps.readPersistedLanes()
    if (!rows) {
      return
    }
    this.rehydrated = true
    this.registry.rehydrate(rows)
  }

  /**
   * Does the host know a pane under this key at all?
   *
   * A pending tab that has never spawned lives only in the mobile-session snapshot, and answering
   * `unknown` for it would let the adopt gate treat a tap on it as a fresh mint (§2a, §3).
   */
  private paneSurfaceExists(worktreeId: string, tabId: string, leafId: string): boolean {
    if (this.deps.rendererLeafExists(tabId, leafId)) {
      return true
    }
    const paneKey = makePaneKey(tabId, leafId)
    for (const livePaneKey of this.deps.livePtyPaneKeys()) {
      if (livePaneKey === paneKey) {
        return true
      }
    }
    if (
      this.deps.workspaceSessionOf(worktreeId)?.terminalPtyIncarnationsByPaneKey?.[paneKey] !==
      undefined
    ) {
      return true
    }
    return (this.deps.mobileSessionTabsOf(worktreeId)?.tabs ?? []).some(
      (tab) => tab.type === 'terminal' && makePaneKey(tab.parentTabId, tab.leafId) === paneKey
    )
  }

  lookup(worktreeId: string, tabId: string, leafId: string): PaneCredentialLaneLookup {
    this.ensureRehydrated()
    return this.registry.lookup(
      worktreeId,
      makePaneKey(tabId, leafId),
      this.paneSurfaceExists(worktreeId, tabId, leafId)
    )
  }

  laneOf(worktreeId: string, paneKey: string): PaneCredentialLane | null {
    this.ensureRehydrated()
    return this.registry.laneOf(worktreeId, paneKey)
  }

  /** Write-once: a respawn into a bound pane runs on the row's lane, never the caller's. */
  bind(
    worktreeId: string,
    tabId: string,
    leafId: string,
    lane: PaneCredentialLane,
    connectionId?: string | null
  ): PaneCredentialLane {
    this.ensureRehydrated()
    const bound = this.registry.bind(
      worktreeId,
      makePaneKey(tabId, leafId),
      laneForPaneConnection(lane, connectionId)
    )
    if (connectionId) {
      // Why: a remote pane's lane is `shared` by construction, so its row carries nothing a
      // restart cannot re-derive — and it belongs to that host's session partition, not the local
      // one that `persistLane` writes.
      return bound
    }
    this.deps.persistLane({
      worktreeId,
      tabId,
      leafId,
      ...(bound.kind === 'principal' ? { principalId: bound.principalId } : {})
    })
    return bound
  }

  /**
   * A pane the renderer mints is an anonymous local create, so it states the shared lane rather
   * than staying unattributed. Write-once, so a pane the funnel already bound to a principal — and
   * every rehydrated row — keeps its lane (§2a).
   *
   * A *reattach* attributes nothing: a pane restored from a pre-lane state carries no lane and
   * must keep rendering `unknown`, which is what makes its split, recovery and resume fail closed
   * rather than quietly reading as the shared credential (§2h).
   */
  bindMintedPane(
    worktreeId: string,
    tabId: string,
    leafId: string,
    connectionId?: string | null,
    isReattach?: boolean
  ): void {
    if (isReattach && this.laneOf(worktreeId, makePaneKey(tabId, leafId)) === null) {
      return
    }
    this.bind(worktreeId, tabId, leafId, SHARED_CREDENTIAL_LANE, connectionId)
  }

  laneOfPty(ptyId: string): PaneCredentialLaneLookup {
    const pane = this.deps.paneOfPty(ptyId)
    if (!pane) {
      return { kind: 'unknown' }
    }
    this.ensureRehydrated()
    return this.registry.lookup(pane.worktreeId, pane.paneKey, true)
  }

  /**
   * The lane an `inherit` edge resolves to, through the ownership predicate.
   *
   * A source pane on a remote connection is exempt: it carries no lane by construction, so no
   * credential is at stake and the predicate would only refuse a legitimate remote split (§2a).
   */
  inheritedLaneOfPty(
    ptyId: string,
    caller: { pairedDeviceId?: string | null }
  ): PaneCredentialLane {
    if (this.deps.paneOfPty(ptyId)?.connectionId) {
      return SHARED_CREDENTIAL_LANE
    }
    return resolveInheritedLane(this.laneOfPty(ptyId), {
      pairedDeviceId: caller.pairedDeviceId,
      callerLane: this.callerLane(caller.pairedDeviceId)
    })
  }

  /** The same predicate for a pane addressed by identity rather than by a live PTY. */
  inheritedLaneOfPane(
    pane: { worktreeId: string; tabId: string; leafId: string },
    caller: { pairedDeviceId?: string | null }
  ): PaneCredentialLane {
    return resolveInheritedLane(this.lookup(pane.worktreeId, pane.tabId, pane.leafId), {
      pairedDeviceId: caller.pairedDeviceId,
      callerLane: this.callerLane(caller.pairedDeviceId)
    })
  }

  /**
   * The renderer-notified split re-enters through the anonymous renderer path, which mints a pane
   * the host cannot pin to a lane. A lane pane's split therefore fails closed here (§2a, §3) —
   * after the ownership predicate, so a cross-lane split is still refused `lane_not_owned`.
   */
  assertRendererSplittable(
    pane: { worktreeId: string; tabId: string; leafId: string },
    caller: { pairedDeviceId?: string | null }
  ): void {
    if (this.inheritedLaneOfPane(pane, caller).kind === 'principal') {
      throw new ClaudeLaneRefusal(
        'terminal.lane_renderer_split_unsupported',
        'That terminal is pinned to your Claude credential lane and its process has already exited, so Orca cannot split it without moving the new pane onto the shared credential. Open a new terminal in your lane instead.'
      )
    }
  }

  /**
   * A federated create has no source pane and no `pairedDeviceId`: it binds the link's principal
   * or fails closed. Never a grant — the union has no such case — and never an implicit shared.
   */
  federatedLinkLane(homePeerFingerprint: string | undefined): PaneCredentialLane {
    if (!this.principals) {
      // Why: with no principal registry wired there are no lanes on this host, so `shared` is not
      // a downgrade — it is the only lane. The refusal below arms with the registry.
      return SHARED_CREDENTIAL_LANE
    }
    const principalId = homePeerFingerprint
      ? (this.principals.linkPrincipalOf(homePeerFingerprint) ?? null)
      : null
    if (!principalId) {
      throw new ClaudeLaneRefusal(
        'terminal.lane_link_unbound',
        'This federated link is not tied to a person on this host, so Orca will not create a workspace or terminal for it. Approve the link on the host and retry.'
      )
    }
    return { kind: 'principal', principalId }
  }

  /**
   * Presentation is a client preference; pane binding is authority, so a lane create is never
   * handed to the renderer to mint (§2a(i)) — and that branch requires a workspace selector.
   */
  assertLaneCreateHasWorkspace(
    lane: PaneCredentialLane,
    worktreeSelector: string | undefined
  ): void {
    if (lane.kind === 'principal' && worktreeSelector === undefined) {
      throw new ClaudeLaneRefusal(
        'terminal.lane_requires_workspace',
        'Orca needs to know which workspace this terminal belongs to before it can start it in your Claude credential lane. Open a workspace and try again.'
      )
    }
  }

  /**
   * The slept panes in this worktree that are bound to a principal's lane.
   *
   * The record's lane is the *pane's* row, read by the same paneKey the record carries — one
   * authority, and it survives a restart with the binding row (§2a, §2h).
   */
  laneBoundSleepingPaneKeys(
    records: Readonly<Record<string, SleepingAgentSessionRecord>>,
    worktreeId: string
  ): string[] {
    this.ensureRehydrated()
    return Object.values(records)
      .filter(
        (record) =>
          record.worktreeId === worktreeId &&
          this.registry.laneOf(record.worktreeId, record.paneKey)?.kind === 'principal'
      )
      .map((record) => record.paneKey)
  }

  forget(worktreeId: string, paneKey: string): void {
    this.registry.forget(worktreeId, paneKey)
  }
}
