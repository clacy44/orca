// Renderer-recovery reattach planner: picks the live local terminals main still holds that a
// recovered window has no tab for, so they can be re-shown attached to the SAME process (and no
// wake path starts a second copy of a running conversation).
//
// Pure on purpose: every runtime fact (inventory, pty records, exclusion sets) is passed in, so
// the candidate filter — including the "deliberately tab-less" exclusions — is testable alone.
import { parsePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-id-equality'

export type LiveSurfacePtyRecord = {
  ptyId: string
  worktreeId: string
  connectionId: string | null
  /** remote:-scheme or SSH-scoped id; no local inventory speaks for it. */
  remoteScoped: boolean
  tabId: string | null
  paneKey: string | null
  incarnationId: string | null
  /** Monotonic record order; keeps same-tab leaves in a stable order. */
  seq: number
  title: string | null
  launchAgent: TuiAgent | null
  launchConfig: SleepingAgentLaunchConfig | null
}

export type LiveSurfaceInventory = {
  livePtyIds: ReadonlySet<string>
  terminalIdentityByPtyId: ReadonlyMap<string, { handle: string; incarnationId: string }>
}

/** Terminals that are tab-less ON PURPOSE, or that another recovery path owns. */
export type LiveSurfaceExclusionSources = {
  legacyWorkerPtyIds: ReadonlySet<string>
  legacyWorkerPaneKeys: ReadonlySet<string>
  materializeQueuePtyIds: ReadonlySet<string>
  materializeQueuePaneKeys: ReadonlySet<string>
  /** Created with explicit background presentation (automation, orchestration worker, lane wake,
   * chair restore ...) and never revealed since — a missing tab is the design, not a loss. */
  surfacelessBackgroundPtyIds: ReadonlySet<string>
  /** A close/kill was requested; the user (or CLI) removed the tab and the stop is in flight. */
  shutdownRequestedPtyIds: ReadonlySet<string>
}

export type LiveSurfaceRevealItem = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  incarnationId: string | null
  title: string | null
  launchAgent: TuiAgent | null
  launchConfig: SleepingAgentLaunchConfig | null
  expectedProcessIdentity: { terminalHandle: string; incarnationId: string } | null
}

export type LiveSurfaceRevealGroup = {
  tabId: string
  /** A sibling leaf of this tab already handled this epoch; the first item splits from it. */
  anchorLeafId: string | null
  items: LiveSurfaceRevealItem[]
}

export type ReceiptOutcome = 'revealed' | 'owned' | 'refused'

export class LiveSurfaceReceipts {
  private readonly byPtyId = new Map<
    string,
    { epoch: number; incarnationId: string | null; outcome: ReceiptOutcome }
  >()

  record(
    ptyId: string,
    incarnationId: string | null,
    epoch: number,
    outcome: ReceiptOutcome
  ): void {
    this.byPtyId.set(ptyId, { epoch, incarnationId, outcome })
  }

  get(ptyId: string, incarnationId: string | null, epoch: number): ReceiptOutcome | null {
    const entry = this.byPtyId.get(ptyId)
    return entry && entry.epoch === epoch && entry.incarnationId === incarnationId
      ? entry.outcome
      : null
  }

  prune(livePtyIds: ReadonlySet<string>): void {
    for (const ptyId of this.byPtyId.keys()) {
      if (!livePtyIds.has(ptyId)) {
        this.byPtyId.delete(ptyId)
      }
    }
  }

  delete(ptyId: string): void {
    this.byPtyId.delete(ptyId)
  }
}

export type LiveSurfacePlan = {
  groups: LiveSurfaceRevealGroup[]
  skipped: { ptyId: string; reason: string }[]
}

export function planLiveTerminalSurfaceReveals(input: {
  ptys: Iterable<LiveSurfacePtyRecord>
  inventory: LiveSurfaceInventory
  exclusions: LiveSurfaceExclusionSources
  isKnownWorktree: (worktreeId: string) => boolean
  receipts: LiveSurfaceReceipts
  epoch: number
}): LiveSurfacePlan {
  const { inventory, exclusions, receipts, epoch } = input
  const skipped: LiveSurfacePlan['skipped'] = []
  const eligible: (LiveSurfaceRevealItem & { seq: number })[] = []
  for (const pty of input.ptys) {
    const skip = (reason: string): void => {
      skipped.push({ ptyId: pty.ptyId, reason })
    }
    // Why the inventory and not `pty.connected`: right after a renderer death the cached flag can
    // briefly read false for a process that is alive.
    if (!inventory.livePtyIds.has(pty.ptyId)) {
      skip('not_in_inventory')
      continue
    }
    if (pty.connectionId !== null || pty.remoteScoped) {
      skip('remote')
      continue
    }
    if (!pty.worktreeId) {
      skip('no_worktree')
      continue
    }
    // Why: the floating workspace persists and restores its own tabs; it is not a worktree tab list.
    if (runtimeWorktreeIdsEqual(pty.worktreeId, FLOATING_TERMINAL_WORKTREE_ID)) {
      skip('floating_workspace')
      continue
    }
    const parsed = pty.paneKey ? parsePaneKey(pty.paneKey) : null
    if (!pty.tabId || !isValidTerminalTabId(pty.tabId) || !parsed || parsed.tabId !== pty.tabId) {
      skip('bad_surface')
      continue
    }
    if (
      exclusions.legacyWorkerPtyIds.has(pty.ptyId) ||
      exclusions.legacyWorkerPaneKeys.has(pty.paneKey!)
    ) {
      skip('legacy_worker')
      continue
    }
    if (
      exclusions.materializeQueuePtyIds.has(pty.ptyId) ||
      exclusions.materializeQueuePaneKeys.has(pty.paneKey!)
    ) {
      skip('materialize_queue')
      continue
    }
    if (exclusions.shutdownRequestedPtyIds.has(pty.ptyId)) {
      skip('shutdown_requested')
      continue
    }
    if (exclusions.surfacelessBackgroundPtyIds.has(pty.ptyId)) {
      skip('surfaceless_background')
      continue
    }
    // Why: a worktree the user removed (or one the catalog cannot confirm yet) must not get tabs.
    if (!input.isKnownWorktree(pty.worktreeId)) {
      skip('unknown_worktree')
      continue
    }
    const identity = inventory.terminalIdentityByPtyId.get(pty.ptyId)
    if (pty.incarnationId && (!identity || identity.incarnationId !== pty.incarnationId)) {
      skip('incarnation_mismatch')
      continue
    }
    eligible.push({
      ptyId: pty.ptyId,
      worktreeId: pty.worktreeId,
      tabId: pty.tabId,
      leafId: parsed.leafId,
      incarnationId: pty.incarnationId,
      title: pty.title,
      launchAgent: pty.launchAgent,
      launchConfig: pty.launchConfig,
      expectedProcessIdentity:
        pty.incarnationId && identity
          ? { terminalHandle: identity.handle, incarnationId: identity.incarnationId }
          : null,
      seq: pty.seq
    })
  }

  // Two live ptys claiming one leaf cannot both be shown; showing either guesses.
  const leafClaims = new Map<string, number>()
  for (const item of eligible) {
    const key = `${item.tabId}\0${item.leafId}`
    leafClaims.set(key, (leafClaims.get(key) ?? 0) + 1)
  }
  const unique = eligible.filter((item) => {
    if ((leafClaims.get(`${item.tabId}\0${item.leafId}`) ?? 0) > 1) {
      skipped.push({ ptyId: item.ptyId, reason: 'duplicate_pane_key' })
      return false
    }
    return true
  })

  const byTab = new Map<string, (LiveSurfaceRevealItem & { seq: number })[]>()
  for (const item of unique) {
    const list = byTab.get(item.tabId) ?? []
    list.push(item)
    byTab.set(item.tabId, list)
  }
  const groups: LiveSurfaceRevealGroup[] = []
  for (const [tabId, list] of byTab) {
    list.sort((a, b) => a.seq - b.seq)
    const pending: LiveSurfaceRevealItem[] = []
    let anchorLeafId: string | null = null
    for (const { seq: _seq, ...item } of list) {
      const outcome = receipts.get(item.ptyId, item.incarnationId, epoch)
      if (outcome === null) {
        pending.push(item)
        continue
      }
      skipped.push({ ptyId: item.ptyId, reason: `receipt_${outcome}` })
      if (anchorLeafId === null && outcome !== 'refused') {
        anchorLeafId = item.leafId
      }
    }
    if (pending.length > 0) {
      groups.push({ tabId, anchorLeafId, items: pending })
    }
  }
  return { groups, skipped }
}

/** Per-reason skip counts as breadcrumb fields (`skip_<reason>`), so a silent exclusion is visible. */
export function countLiveSurfaceSkips(plan: LiveSurfacePlan): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { reason } of plan.skipped) {
    counts[`skip_${reason}`] = (counts[`skip_${reason}`] ?? 0) + 1
  }
  return counts
}
