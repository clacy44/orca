// S10-21f b2-10q R143: dead reporter's stale-but-recent hook report must not block adoption. Pure
// — no IO, no DB, no timers. The caller (chair-restore.ts) gathers every input: the hook server's
// `liveReportPanesForSession` set (excluding the holder's own pane), the ONE inventory round the
// restore already took, and two resolvers over that round for each reporter's own pane
// (`ptyIdForPane`/`connectedNow`).
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { combinedOccupantLiveness, type OccupantLiveness } from './restore-sweep-decision'
import type { ControllerInventory } from './agent-process-identity'

export type LiveReportPaneReporter = { paneKey: string; executionHostId: string }

/** TRUE (the report stands — contests adoption) if the inventory round is null, OR a reporter is
 * non-local, OR no ptyId resolves for a reporter's pane, OR that pane's combined (round ∪
 * connected-now) occupant liveness is not explicitly 'absent'. FALSE (every reporter discounted)
 * only when EVERY reporter resolves a ptyId over a non-null round whose combined liveness is
 * 'absent' — a dead reporter's stale report never blocks adoption, but any live or unresolvable
 * one still does. An empty `reporters` list (no report at all) is FALSE by construction: the loop
 * never finds one that stands. */
export function liveReportOnLivePaneElsewhere(
  reporters: readonly LiveReportPaneReporter[],
  inventory: ControllerInventory | null,
  ptyIdForPane: (paneKey: string) => string | undefined,
  connectedNow: (paneKey: string) => boolean
): boolean {
  for (const reporter of reporters) {
    if (inventory === null) {
      return true
    }
    if (reporter.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return true
    }
    const ptyId = ptyIdForPane(reporter.paneKey)
    if (ptyId === undefined) {
      return true
    }
    const round: OccupantLiveness = inventory.allLivePtyIds.has(ptyId) ? 'present' : 'absent'
    if (combinedOccupantLiveness(round, connectedNow(reporter.paneKey)) !== 'absent') {
      return true
    }
  }
  return false
}

/** [MAX-LINES] The caller's own IO shape, structurally typed (never `OrcaRuntimeService` itself —
 * this file stays pure) so chair-restore.ts can hand its `deps.runtime` straight through instead
 * of inlining ptyId resolution. `reporters === null` (the pane-granular accessor unwired) is the
 * SAME fail-closed default as a standing reporter — never guessed discounted. */
export type LiveReportRuntimeDeps = {
  findConnectedPtyForPane: (paneKey: string) => { ptyId: string } | undefined
  getPersistedPtyIdForLeaf: (
    tabId: string,
    leafId: string,
    hostId?: string | null
  ) => string | undefined
}

export function liveReportStandsElsewhere(
  reporters: readonly LiveReportPaneReporter[] | null,
  inventory: ControllerInventory | null,
  hostId: string,
  deps: LiveReportRuntimeDeps
): boolean {
  if (reporters === null) {
    return true
  }
  return liveReportOnLivePaneElsewhere(
    reporters,
    inventory,
    (paneKey) => {
      const connected = deps.findConnectedPtyForPane(paneKey)
      if (connected) {
        return connected.ptyId
      }
      const parsed = parsePaneKey(paneKey)
      return parsed ? deps.getPersistedPtyIdForLeaf(parsed.tabId, parsed.leafId, hostId) : undefined
    },
    (paneKey) => deps.findConnectedPtyForPane(paneKey) !== undefined
  )
}
