// Why a pure predicate beside the chip: whether the "open in my lane" affordance is OFFERED is a
// three-part rule (S9 §2h/§5, and the `terminal.openInMyLane` backend's `callerMayOpenSourceLane`),
// and it must be assertable without a DOM:
//   (i)   the host must advertise `agent.identity-lanes.v1` — hidden outright when it does not, so
//         an older host shows a stack trace to nobody (§3, the capability's whole reason);
//   (ii)  the row must be attributed to a PERSON — a shared, remote, WSL or unattributed row has no
//         source lane to open into;
//   (iii) it must not be the viewer's OWN lane — opening your own lane in your own lane is a no-op,
//         and the backend refuses `terminal.lane_open_forbidden` for the wrong-principal case.
import type { TerminalPresenceParticipant } from '@/lib/pane-manager/terminal-presence-state'
import type { TerminalCredentialLaneAttribution } from './terminal-credential-lane-attribution'

/**
 * True when the viewer already owns this terminal's credential lane — the person whose lane it is
 * is attached from this very client (§2h: one owner label over a desktop AND a phone, so `self` is
 * the discriminator, not the participant count).
 */
export function viewerOwnsCredentialLane(
  participants: readonly TerminalPresenceParticipant[]
): boolean {
  return participants.some(
    (participant) => participant.self === true && participant.credentialLaneOwner === true
  )
}

export function shouldOfferOpenInMyLane(input: {
  capabilitySupported: boolean
  attribution: TerminalCredentialLaneAttribution
  viewerOwnsLane: boolean
}): boolean {
  if (!input.capabilitySupported) {
    return false
  }
  if (input.attribution.kind !== 'owned') {
    return false
  }
  return !input.viewerOwnsLane
}
