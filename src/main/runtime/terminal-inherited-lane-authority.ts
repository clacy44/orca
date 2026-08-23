import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  laneEquals,
  type PaneCredentialLane,
  type PaneCredentialLaneLookup
} from './pane-credential-lane-registry'

/**
 * The caller an `inherit` edge is asking on behalf of.
 *
 * `callerLane` is the funnel resolver's answer: `shared` for an anonymous socket *and* for a grant
 * bound to no principal, which is the lane-less grant of rev 10 byte-for-byte.
 */
export type InheritedLaneCaller = {
  /** Absent for the Unix-socket CLI and the renderer bridge — case (ii) below. */
  pairedDeviceId?: string | null
  callerLane: PaneCredentialLane
}

/**
 * One ownership predicate for every `inherit` edge (S9 §2a).
 *
 * "The worker runs on the coordinator's authority" says nothing about whether the caller has any
 * relationship to the pane it names, so `orchestration.workerStart`, `terminal.split` (including
 * the `agentTeams.tmuxCompat` door into it), the federated worker start, the coordinator loop and
 * pane recovery all resolve through here. Attachment is deliberately not the predicate: R4 hands a
 * peer an attachment on someone else's pane.
 */
export function resolveInheritedLane(
  source: PaneCredentialLaneLookup,
  caller: InheritedLaneCaller
): PaneCredentialLane {
  if (source.kind !== 'bound') {
    // Why: a pane restored from a pre-lane state is never attributed, so inheriting from it would
    // have to guess — split, recovery and resume of it fail closed instead (§2h).
    throw new ClaudeLaneRefusal(
      'terminal.lane_source_unknown',
      'Orca cannot tell which Claude credential this terminal is using, so it will not open another pane from it. Create a new terminal instead.'
    )
  }
  const anonymous =
    caller.pairedDeviceId === undefined ||
    caller.pairedDeviceId === null ||
    caller.pairedDeviceId.length === 0
  // (ii) an anonymous local caller is today's behaviour, and it is the path an agent inside the
  // pane takes when it runs `orca worker-start --from <its own pane>`.
  if (anonymous) {
    return source.lane
  }
  // (i) same principal — the pane already stores it, so this is a read and not a second lookup.
  if (caller.callerLane.kind === 'principal' && laneEquals(source.lane, caller.callerLane)) {
    return source.lane
  }
  // (iii) a shared source, inherited by a caller that holds no lane.
  if (source.lane.kind === 'shared' && caller.callerLane.kind === 'shared') {
    return source.lane
  }
  throw new ClaudeLaneRefusal(
    'terminal.lane_not_owned',
    'That terminal runs on another person’s Claude credential lane, so Orca will not start a new pane from it on your behalf. Use one of your own terminals.'
  )
}
