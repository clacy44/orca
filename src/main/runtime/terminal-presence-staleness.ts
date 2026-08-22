// Why its own module: mobile is the one participant kind with no host-side liveness at all, so the rule
// that keeps a silent phone honest — mark it, never reap it — belongs in one place every surface reads.
// A relay data socket has no heartbeat (that construction site is direct-WebSocket only), the phone
// disables idle probes so it must not hold a billed relay splice, and it sends nothing while
// backgrounded. Silence is therefore normal for a LIVE phone, and removal stays lifecycle-driven.
import type { TerminalPresenceKind } from './terminal-presence-snapshot'
import { HOST_ATTACHMENT_KEY, type TerminalPresenceRegistry } from './terminal-presence-registry'
import { MOBILE_PRESENCE_STALE_MS } from '../../shared/terminal-presence-last-seen'

// Why the horizon lives in shared and not here: the registry needs it to spot the recovery edge, and an
// import back from there would be a value cycle through this module. Re-exported so every reader of the
// staleness rule still finds it beside the rule.
export { MOBILE_PRESENCE_STALE_MS }

/** Present only on a stale row: `stale` is the flag every surface branches on, `lastSeenAt` is the host
 *  clock stamp the copy counts minutes from — the same domain `lastOutputAt` already publishes in. */
export type MobilePresenceStaleness = { stale: true; lastSeenAt: number }

// Why aggregated by participantId: one grant can hold a terminal socket and a shared-control socket, and
// a frame on either proves the phone is alive — reading one connection alone would mark a live phone.
function collectMobilePresenceLastInbound(registry: TerminalPresenceRegistry): Map<string, number> {
  const lastInboundByParticipant = new Map<string, number>()
  for (const participant of registry.connections().values()) {
    if (participant.kind !== 'mobile') {
      continue
    }
    const known = lastInboundByParticipant.get(participant.participantId)
    lastInboundByParticipant.set(
      participant.participantId,
      known === undefined ? participant.lastInboundAt : Math.max(known, participant.lastInboundAt)
    )
  }
  return lastInboundByParticipant
}

// Why kind-gated rather than applied to every row: a runtime-scope peer IS heartbeat-bounded, so marking
// it stale would blend two different liveness contracts into one word the reader cannot tell apart.
export function resolveMobilePresenceStaleness(
  kind: TerminalPresenceKind,
  lastInboundAt: number | undefined,
  now: number
): MobilePresenceStaleness | null {
  if (kind !== 'mobile' || lastInboundAt === undefined || lastInboundAt <= 0) {
    return null
  }
  return now - lastInboundAt >= MOBILE_PRESENCE_STALE_MS
    ? { stale: true, lastSeenAt: lastInboundAt }
    : null
}

// Why a deadline and not a sweep: going stale is a state change no mutator reports — the phone did
// nothing, which is the whole point — so without it the last published payload keeps a dead phone
// rendered as freshly attached until some unrelated change happens to republish. It expires a FLAG,
// never a row: nothing here removes a participant.
export function nextMobilePresenceStaleAt(
  registry: TerminalPresenceRegistry,
  at: number,
  ptyId?: string
): number | null {
  const lastInboundByParticipant = collectMobilePresenceLastInbound(registry)
  const scoped = ptyId === undefined ? null : mobileParticipantIdsOnPty(registry, ptyId)
  let earliest: number | null = null
  for (const [participantId, lastInboundAt] of lastInboundByParticipant) {
    if (scoped && !scoped.has(participantId)) {
      continue
    }
    const deadline = lastInboundAt + MOBILE_PRESENCE_STALE_MS
    // Why strictly future: a deadline already met marks a row that is already stale, and re-arming on it
    // would spin one timer per emit for a phone that will never speak again.
    if (deadline > at && (earliest === null || deadline < earliest)) {
      earliest = deadline
    }
  }
  return earliest
}

function mobileParticipantIdsOnPty(registry: TerminalPresenceRegistry, ptyId: string): Set<string> {
  const participantIds = new Set<string>()
  for (const [key, attachment] of registry.attachmentsOf(ptyId)) {
    if (key === HOST_ATTACHMENT_KEY || attachment.connectionId === null) {
      continue
    }
    const participant = registry.getParticipantByConnection(attachment.connectionId)
    if (participant?.kind === 'mobile') {
      participantIds.add(participant.participantId)
    }
  }
  return participantIds
}
