import type { TerminalPresenceParticipant } from './terminal-presence-registry'

/**
 * The owner label's third hop: a presence participant id → the PERSON behind it (S9 §2h).
 *
 * The participant map is keyed by CONNECTION with the grant as a field, and a lane is keyed by
 * principal, so neither map answers this alone and the join is a scan. `terminal.list` asks it
 * once per participant per row, so the scan happens once per response instead: the index is built
 * on the first question and each participant's principal is resolved at most once after that.
 */
export function createPresenceParticipantPrincipalResolver(args: {
  connections: () => ReadonlyMap<string, TerminalPresenceParticipant>
  principalOfGrant: (pairedDeviceId: string) => string | null
}): (participantId: string) => string | null {
  let grantsByParticipant: Map<string, string> | null = null
  const principalsByParticipant = new Map<string, string | null>()
  return (participantId: string): string | null => {
    grantsByParticipant ??= new Map(
      [...args.connections().values()].map((participant) => [
        participant.participantId,
        participant.pairedDeviceId
      ])
    )
    const pairedDeviceId = grantsByParticipant.get(participantId)
    if (pairedDeviceId === undefined) {
      return null
    }
    if (!principalsByParticipant.has(participantId)) {
      principalsByParticipant.set(participantId, args.principalOfGrant(pairedDeviceId))
    }
    return principalsByParticipant.get(participantId) ?? null
  }
}
