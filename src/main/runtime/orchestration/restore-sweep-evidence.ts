// S10-21a C7k (Ruling 34 Addendum 28): the sweep's per-candidate evidence assembly — occupant
// lookup, the identity-tagged IncumbentEvidence, and the combined (round ∪ connected-now)
// occupant liveness — split out of restore-registered-agent-panes.ts to stay under the
// max-lines ratchet. Shared by rows 5-6's own-pane liveness check and rows 8-11's routing.
import type { IncumbentEvidence } from '../incumbent-death'
import type { ControllerInventory, ProcessIdentity } from './agent-process-identity'
import { combinedOccupantLiveness, type OccupantLiveness } from './restore-sweep-decision'

export type SweepOccupant = { paneKey: string; ptyId: string }

export type CollectSweepEvidenceDeps = {
  findConnectedLeafOccupant(leafId: string, tabId?: string | null): SweepOccupant | undefined
  /** [S10-21a C7m, Ruling 34 Addendum 30, item 1] Rows 8-11's own-pane occupant read falls back
   * to the runtime's OWN pty records (same accessor C7l's rows 5-6 already use) — a surviving
   * daemon pty on the persisted pane is an own-pane occupant even before the renderer graph
   * (`findConnectedLeafOccupant`) has published it. Shapes already match (`SweepOccupant`). */
  findConnectedPtyForPane(paneKey: string): SweepOccupant | undefined
  getPersistedPtyIdForLeaf(
    tabId: string,
    leafId: string,
    hostId?: string | null
  ): string | undefined
  collectIncumbentEvidence(
    paneKey: string,
    ptyId: string | undefined,
    now?: number,
    preFetchedInventory?: ControllerInventory | null
  ): Promise<IncumbentEvidence>
}

export type SweepEvidence = {
  occupant: SweepOccupant | undefined
  incumbentEvidence: IncumbentEvidence
  occupantLiveness: OccupantLiveness | undefined
}

/** [C7e/C7h, D-R111 R2, Addendum 26] `this.leaves` occupancy is a RACE at this run point, not an
 * invariant. [C7i, Ruling 34 Addendum 27] The evidence pty prefers the agent's OWN identity,
 * then the row's persisted ptyId, then the occupant's. [C7k, Ruling 34 Addendum 28, item 1] When
 * the identity verdict is 'dead', it is attached to the evidence so `resolveIncumbentDeath` reads
 * it as dominant over D1/D2/D3 — row 4's 'unknown_no_identity' carries no identity to attach.
 * [C7k, item 3] Occupant liveness = the shared round ∪ connected-now, for whichever ptyId the
 * occupant (if any) actually carries. */
export async function collectSweepEvidence(
  deps: CollectSweepEvidenceDeps,
  paneKey: string,
  tabId: string,
  leafId: string,
  hostId: string,
  inventory: ControllerInventory | null,
  identity: ProcessIdentity | null,
  identityStatus: 'dead' | 'unknown_no_identity'
): Promise<SweepEvidence> {
  const occupant =
    deps.findConnectedLeafOccupant(leafId, tabId) ?? deps.findConnectedPtyForPane(paneKey)
  const rowPtyId = deps.getPersistedPtyIdForLeaf(tabId, leafId, hostId)
  const evidencePtyId = identity?.ptyId ?? rowPtyId ?? occupant?.ptyId
  const incumbentEvidenceRaw = await deps.collectIncumbentEvidence(
    paneKey,
    evidencePtyId,
    undefined,
    inventory
  )
  const incumbentEvidence: IncumbentEvidence =
    identityStatus === 'dead' && identity
      ? {
          ...incumbentEvidenceRaw,
          agentIdentity: {
            verdict: 'dead',
            ptyId: identity.ptyId,
            incarnationId: identity.incarnationId
          }
        }
      : incumbentEvidenceRaw
  const occupantLiveness = occupant
    ? combinedOccupantLiveness(
        incumbentEvidence.ptyState?.(occupant.ptyId),
        incumbentEvidence.ptyConnectedNow?.(occupant.ptyId) ?? false
      )
    : undefined
  return { occupant, incumbentEvidence, occupantLiveness }
}
