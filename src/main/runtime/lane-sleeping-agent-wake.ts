import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { PaneCredentialLane } from './pane-credential-lane-registry'

/**
 * How `worktree.activate`'s wake is partitioned host-side (S9 §2a, blocker 2's pane half).
 *
 * The renderer wake does not reuse the slept pane — it calls `createTab` and then clears the
 * record — so the resumed pane is renderer-minted and carries no binding at all, which under §2a
 * means `shared`: a silent downgrade onto the other developer's credential. Lane-bound records
 * are therefore excluded from it and resumed only through the host create path, which mints the
 * paneKey and binds the lane before spawning. A caller the ownership predicate rejects leaves the
 * record ASLEEP (`wake_refused_not_owned`) rather than resuming it on anyone's credential.
 */
export type LaneSleepingWakePartition = {
  /** Every lane-bound pane in this worktree — the set the renderer wake is told to skip. */
  withheldPaneKeys: string[]
  /** The subset this caller's principal owns, to resume through the host create path. */
  ownedRecords: SleepingAgentSessionRecord[]
  /** A lane record belonging to someone else stayed asleep. */
  refusedForeign: boolean
}

export function partitionLaneBoundSleepingRecords(input: {
  records: Readonly<Record<string, SleepingAgentSessionRecord>>
  worktreeId: string
  laneOf(worktreeId: string, paneKey: string): PaneCredentialLane | null
  /** The person behind the caller's grant, or null for an anonymous/unbound caller. */
  callerPrincipalId: string | null
}): LaneSleepingWakePartition {
  const partition: LaneSleepingWakePartition = {
    withheldPaneKeys: [],
    ownedRecords: [],
    refusedForeign: false
  }
  for (const record of Object.values(input.records)) {
    if (record.worktreeId !== input.worktreeId) {
      continue
    }
    const lane = input.laneOf(record.worktreeId, record.paneKey)
    if (lane?.kind !== 'principal') {
      continue
    }
    partition.withheldPaneKeys.push(record.paneKey)
    // Why an equality and not a truthiness check: a caller with NO principal owns nothing, so an
    // anonymous local socket must not be able to resume a lane record by having no identity.
    if (input.callerPrincipalId !== null && lane.principalId === input.callerPrincipalId) {
      partition.ownedRecords.push(record)
    } else {
      partition.refusedForeign = true
    }
  }
  return partition
}
