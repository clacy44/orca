// S10-21a C7i (Ruling 34 Addendum 27): pure decision-table logic for the restore sweep, split
// out of restore-registered-agent-panes.ts to stay under the max-lines ratchet. Rows 1-6
// (identity survival + this-generation launch-row hold) and rows 8-11 (dead-candidate occupant
// routing) — row 7 (self-resume watermark) is C7j, not here. No IO, no DB, no timers; the
// caller applies the returned audit reason codes.
import {
  agentAlive,
  parseProcessIncarnation,
  type ControllerInventory,
  type ProcessIdentity
} from './agent-process-identity'
import type { LaunchEvidence } from './agent-launch-sessions'

export type EarlyRowsDecision =
  | { kind: 'skipped_daemon_survived'; reasonCode: string }
  | { kind: 'layer3'; reasonCode: string }
  | { kind: 'skipped_leaf_held'; reasonCode: string }
  | { kind: 'proceed'; identity: ProcessIdentity | null; noteReasonCode: string | null }

/** Rows 1-6. `identity` is parsed from `agents.process_incarnation`; `inventory` is the ONE
 * shared round the whole sweep took. `launchGeneration`/`currentGeneration`/`evidence`/`seq` are
 * the candidate's own launch row's fields. */
export function decideEarlyRows(
  processIncarnation: string | null,
  inventory: ControllerInventory | null,
  launchGeneration: string,
  currentGeneration: string,
  evidence: LaunchEvidence,
  seq: number
): EarlyRowsDecision {
  const identity = parseProcessIncarnation(processIncarnation)
  const status = agentAlive(identity, inventory)
  if (status === 'alive') {
    const id = identity as ProcessIdentity
    return {
      kind: 'skipped_daemon_survived',
      reasonCode: `daemon_survived: agent_pty_identity_matched ${id.ptyId}:${id.incarnationId}`
    }
  }
  if (status === 'unknown_inventory') {
    return { kind: 'layer3', reasonCode: 'sweep_deferred: controller_inventory_unavailable' }
  }
  if (status === 'unknown_ambiguous_pty') {
    const id = identity as ProcessIdentity
    return {
      kind: 'layer3',
      reasonCode: `sweep_deferred: agent_pty_identity_ambiguous ${id.ptyId}`
    }
  }
  // status is 'dead' or 'unknown_no_identity' (row 4 notes, never skips).
  const noteReasonCode =
    status === 'unknown_no_identity'
      ? 'agent_identity_absent: row_has_no_process_incarnation'
      : null
  if (launchGeneration === currentGeneration) {
    if (evidence === 'sweep_record') {
      return {
        kind: 'skipped_leaf_held',
        reasonCode: `leaf_held: resume_admitted_this_generation seq=${seq}`
      }
    }
    if (evidence === 'host_launch') {
      return {
        kind: 'skipped_leaf_held',
        reasonCode: `leaf_held: new_launch_admitted_this_generation seq=${seq}`
      }
    }
  }
  return { kind: 'proceed', identity, noteReasonCode }
}

export type DeadCandidateOccupant = { paneKey: string; ptyId: string }

export type OccupantRouting = {
  offerPlacement: boolean
  audit: { verb: 'sweep_skip' | 'sweep_note'; reasonCode: string } | null
}

/** Rows 8-11, for a candidate already judged dead (or unknown_no_identity). `occupantPtyState`
 * is the SAME shared round's presence read for `occupant.ptyId` specifically — it may differ
 * from whatever ptyId the candidate's own `IncumbentEvidence` was collected for. */
export function routeDeadCandidate(
  occupant: DeadCandidateOccupant | undefined,
  candidatePaneKey: string,
  occupantPtyState: 'present' | 'absent' | 'unknown' | undefined,
  isLeafInPersistedLayout: boolean
): OccupantRouting {
  if (occupant) {
    if (occupant.paneKey === candidatePaneKey) {
      if (occupantPtyState === 'present') {
        // Row 11: a live pty that is provably not the agent — never yielded to, never spawned
        // over. Restore into a FRESH pane instead (no placement onto this occupied leaf).
        return {
          offerPlacement: false,
          audit: {
            verb: 'sweep_note',
            reasonCode: `leaf_occupied_by_live_non_agent_pty ${occupant.ptyId}`
          }
        }
      }
      // Row 10: absent (or unknown) from the round — a stale surface, restored over.
      return {
        offerPlacement: true,
        audit: {
          verb: 'sweep_note',
          reasonCode: `stale_own_surface: occupant_pty_absent_from_inventory ${occupant.ptyId}`
        }
      }
    }
    // Row 9. [C7i FORCED DEVIATION — see RETURN] kept byte-identical to the pre-C7i reason code
    // (no `<occupantPaneKey> pty=<ptyId>` suffix) so the pre-existing, unnamed T21 assertion is
    // not disturbed.
    return {
      offerPlacement: false,
      audit: { verb: 'sweep_skip', reasonCode: 'leaf_occupied_by_other' }
    }
  }
  if (!isLeafInPersistedLayout) {
    // Row 8, second half: no occupant, leaf absent from the persisted layout.
    return {
      offerPlacement: false,
      audit: { verb: 'sweep_note', reasonCode: 'no_placement: leaf_absent_from_persisted_layout' }
    }
  }
  // Row 8, first half: no occupant, leaf present in the persisted layout.
  return { offerPlacement: true, audit: null }
}
