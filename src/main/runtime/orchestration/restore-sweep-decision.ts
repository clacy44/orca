// S10-21a C7i/C7j/C7k (Ruling 34 Addenda 27/28): pure decision-table logic for the restore sweep,
// split out of restore-registered-agent-panes.ts to stay under the max-lines ratchet. Rows 1-4
// (identity survival), rows 5-6 (this-generation launch-row hold, C7k: only while a live pty
// stands on the pane), row 7 (C7j: self-resume watermark hold), and rows 8-11 (dead-candidate
// occupant routing). No IO, no DB, no timers; the caller runs the DB reads (e.g.
// `db.newestSelfResumeAuditForPane`) and applies the returned audit reason codes.
import {
  agentAlive,
  parseProcessIncarnation,
  type ControllerInventory,
  type ProcessIdentity
} from './agent-process-identity'
import type { LaunchEvidence } from './agent-launch-sessions'
import type { SelfResumeAuditHit } from './agent-sweep-self-resume-watermark'

export type EarlyRowsDecision =
  | { kind: 'skipped_daemon_survived'; reasonCode: string }
  | { kind: 'layer3'; reasonCode: string }
  | {
      kind: 'proceed'
      identity: ProcessIdentity | null
      status: 'dead' | 'unknown_no_identity'
      noteReasonCode: string | null
    }

/** Rows 1-4. `identity` is parsed from `agents.process_incarnation`; `inventory` is the ONE
 * shared round the whole sweep took. [S10-21a C7k, Ruling 34 Addendum 28, D-R118] Inventory
 * availability is judged FIRST — a null round defers (row 2) regardless of identity, before
 * `agentAlive` is even consulted (its own no-identity check would otherwise win row 4 over row 2
 * for a candidate with neither an identity nor a round). */
export function decideEarlyRows(
  processIncarnation: string | null,
  inventory: ControllerInventory | null
): EarlyRowsDecision {
  if (inventory === null) {
    return { kind: 'layer3', reasonCode: 'sweep_deferred: controller_inventory_unavailable' }
  }
  const identity = parseProcessIncarnation(processIncarnation)
  const status = agentAlive(identity, inventory)
  if (status === 'alive') {
    const id = identity as ProcessIdentity
    return {
      kind: 'skipped_daemon_survived',
      reasonCode: `daemon_survived: agent_pty_identity_matched ${id.ptyId}:${id.incarnationId}`
    }
  }
  if (status === 'unknown_ambiguous_pty') {
    const id = identity as ProcessIdentity
    return {
      kind: 'layer3',
      reasonCode: `sweep_deferred: agent_pty_identity_ambiguous ${id.ptyId}`
    }
  }
  // status is 'dead' or 'unknown_no_identity' here — 'alive'/'unknown_ambiguous_pty' returned
  // above, and 'unknown_inventory' cannot occur (`inventory` is non-null at this point).
  const finalStatus = status === 'unknown_no_identity' ? 'unknown_no_identity' : 'dead'
  const noteReasonCode =
    finalStatus === 'unknown_no_identity'
      ? 'agent_identity_absent: row_has_no_process_incarnation'
      : null
  return { kind: 'proceed', identity, status: finalStatus, noteReasonCode }
}

export type LeafHoldDecision =
  | { kind: 'skipped_leaf_held'; reasonCode: string }
  | { kind: 'proceed'; noteReasonCode: string | null }

/** Rows 5-6. [S10-21a C7k, Ruling 34 Addendum 28, D-R118] An admitted launch this generation
 * holds the leaf ONLY while a live pty actually stands on the pane — `occupantOnOwnPaneLive` is
 * the caller's own-pane occupant liveness (round ∪ connected-now, per `routeDeadCandidate`'s
 * same combination). Otherwise this proceeds to rows 8-11 with a note instead of a skip. */
export function decideLeafHoldRows(
  launchGeneration: string,
  currentGeneration: string,
  evidence: LaunchEvidence,
  seq: number,
  occupantOnOwnPaneLive: boolean
): LeafHoldDecision {
  if (launchGeneration === currentGeneration) {
    if (evidence === 'sweep_record' || evidence === 'host_launch') {
      if (occupantOnOwnPaneLive) {
        return {
          kind: 'skipped_leaf_held',
          reasonCode:
            evidence === 'sweep_record'
              ? `leaf_held: resume_admitted_this_generation seq=${seq}`
              : `leaf_held: new_launch_admitted_this_generation seq=${seq}`
        }
      }
      return {
        kind: 'proceed',
        noteReasonCode: `admitted_launch_without_live_pty seq=${seq} evidence=${evidence}`
      }
    }
  }
  return { kind: 'proceed', noteReasonCode: null }
}

export type Row7Decision = { kind: 'skipped_leaf_held'; reasonCode: string } | { kind: 'proceed' }

/** Row 7 (C7j, Ruling 34 Addendum 27): a self-resume audited since this process started holds
 * the leaf. Evaluated only when rows 1-6 returned `proceed` and only when the watermark was
 * captured — an absent watermark is the caller's own concern (one sweep_note, row 7 skipped
 * entirely), not this function's; it is never called with one. `newestAudit` is the caller's own
 * `db.newestSelfResumeAuditForPane` read for this pane, already filtered to `seq > watermark`. */
export function decideRow7(newestAudit: SelfResumeAuditHit | null): Row7Decision {
  if (newestAudit) {
    return {
      kind: 'skipped_leaf_held',
      reasonCode: `leaf_held: self_resume_audited_this_process seq=${newestAudit.seq}`
    }
  }
  return { kind: 'proceed' }
}

export type DeadCandidateOccupant = { paneKey: string; ptyId: string }

export type OccupantRouting = {
  offerPlacement: boolean
  audit: { verb: 'sweep_skip' | 'sweep_note'; reasonCode: string } | null
}

export type OccupantLiveness = 'present' | 'absent' | 'unknown'

/** [S10-21a C7k, Ruling 34 Addendum 28, D-R118] Occupant liveness = the union of the shared
 * round's own read (`ptyState`) and the runtime's connected-now read (`ptyConnectedNow`):
 * 'present' if EITHER says so; 'absent' only when the round-based read is explicitly 'absent'
 * (round non-null, does not list the pty) AND it is not connected now; 'unknown' otherwise (the
 * round-based read is 'unknown' or the evidence never supplied one at all). */
export function combinedOccupantLiveness(
  ptyState: OccupantLiveness | undefined,
  connectedNow: boolean
): OccupantLiveness {
  if (ptyState === 'present' || connectedNow) {
    return 'present'
  }
  if (ptyState === 'absent') {
    return 'absent'
  }
  return 'unknown'
}

/** Rows 8-11, for a candidate already judged dead (or unknown_no_identity). `occupantLiveness`
 * is the combined (round ∪ connected-now) liveness of `occupant.ptyId` specifically — it may
 * differ from whatever ptyId the candidate's own `IncumbentEvidence` was collected for.
 * [S10-21a C7k, Ruling 34 Addendum 28, D-R118] Row 10 requires liveness EXPLICITLY 'absent';
 * 'unknown' takes row 11's no-placement treatment, under its own reason code — never row 10's. */
export function routeDeadCandidate(
  occupant: DeadCandidateOccupant | undefined,
  candidatePaneKey: string,
  occupantLiveness: OccupantLiveness | undefined,
  isLeafInPersistedLayout: boolean,
  inventory: ControllerInventory | null
): OccupantRouting {
  if (occupant) {
    if (occupant.paneKey === candidatePaneKey) {
      if (occupantLiveness === 'present') {
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
      if (occupantLiveness === 'absent') {
        // Row 10: explicitly absent from the round (and not connected now) — a stale surface,
        // restored over.
        return {
          offerPlacement: true,
          audit: {
            verb: 'sweep_note',
            reasonCode: `stale_own_surface: occupant_pty_absent_from_inventory ${occupant.ptyId}`
          }
        }
      }
      // 'unknown' (or the evidence supplied no liveness read at all) — never place, same as
      // row 11's caution, under its own distinct reason.
      return {
        offerPlacement: false,
        audit: {
          verb: 'sweep_note',
          reasonCode: `leaf_liveness_unknown: occupant ${occupant.ptyId} round=${
            inventory === null ? 'null' : 'present'
          }`
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
