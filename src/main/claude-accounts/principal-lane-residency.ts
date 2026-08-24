import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import {
  resolveOwnedPrincipalLaneDir,
  type PrincipalLaneOptions
} from './principal-credential-lane'
import { isLaneLoaded } from './principal-lane-credential-sweep'

/**
 * Whether a principal's lane holds a credential on this host right now (S9 §2h).
 *
 * `absent` covers both "no lane directory Orca can prove it owns" and "a lane with no
 * `.credentials.json`", because a launch fails closed on either — and because a row that claimed
 * residency the host cannot prove is the misattribution the lane exists to close.
 *
 * `reauth-required` is S9b's: it is the outcome of a FOREIGN rotation, which only the sync driver
 * can detect, so nothing here may synthesize it from a file's presence.
 */
export function resolveLaneResidencyState(
  principalId: string,
  options: PrincipalLaneOptions = {}
): RuntimeTerminalLaneState {
  const laneDir = resolveOwnedPrincipalLaneDir(principalId, options)
  return laneDir && isLaneLoaded(laneDir) ? 'loaded' : 'absent'
}
