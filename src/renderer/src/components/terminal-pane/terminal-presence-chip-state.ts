// Why a pure resolver beside the component: the state ladder is the part with rules (typing outranks
// writing, a hold outranks both, a stale phone outranks nothing, `self` is never a peer), and it must be
// assertable without a DOM.
import type {
  TerminalPanePresence,
  TerminalPresenceParticipant
} from '@/lib/pane-manager/terminal-presence-state'

export type TerminalPresenceChipActivity = 'attached' | 'stale' | 'writing' | 'typing' | 'held'

/** A discriminated union rather than an optional stamp: the staleness copy counts minutes from
 *  `lastSeenAt`, so the one state that renders it is the one state that must carry it. */
export type TerminalPresenceChipState =
  | { label: string; activity: Exclude<TerminalPresenceChipActivity, 'stale'> }
  | { label: string; activity: 'stale'; lastSeenAt: number }

// Why typing outranks writing: the interactive stamp is the one that can hold your keystroke, so a
// participant doing both must read as the state with consequences.
function activityRank(participant: TerminalPresenceParticipant): number {
  if (participant.typing) {
    return 2
  }
  if (participant.writing) {
    return 1
  }
  // Why below plain attached: a phone the host has not heard from in two minutes is the least likely
  // peer to be about to collide with you, so it must never displace one who is here.
  return participant.stale ? -1 : 0
}

function pickLoudestPeer(
  participants: readonly TerminalPresenceParticipant[]
): TerminalPresenceParticipant | null {
  let loudest: TerminalPresenceParticipant | null = null
  for (const participant of participants) {
    if (participant.self) {
      continue
    }
    if (!loudest || activityRank(participant) > activityRank(loudest)) {
      loudest = participant
    }
  }
  return loudest
}

/** Null when nobody but the reader is on this PTY — the chip is ambient, so an empty roster renders nothing. */
export function resolveTerminalPresenceChipState(
  presence: TerminalPanePresence
): TerminalPresenceChipState | null {
  const held = presence.arbitration
    ? presence.participants.find(
        (participant) =>
          participant.participantId === presence.arbitration?.heldFor && !participant.self
      )
    : undefined
  if (held) {
    // Why the hold wins outright: it is the only state that asks the reader to do something.
    return { label: held.label, activity: 'held' }
  }
  const peer = pickLoudestPeer(presence.participants)
  if (!peer) {
    return null
  }
  // Why on `stale` alone and not on both fields: a stale row is one the host has heard nothing from, so
  // rendering it as typing would report a stamp that no longer proves anybody is there. The stamp only
  // decides whether the copy can say HOW long — without it the row falls back to plain "attached".
  if (peer.stale) {
    return peer.lastSeenAt === undefined
      ? { label: peer.label, activity: 'attached' }
      : { label: peer.label, activity: 'stale', lastSeenAt: peer.lastSeenAt }
  }
  if (peer.typing) {
    return { label: peer.label, activity: 'typing' }
  }
  return { label: peer.label, activity: peer.writing ? 'writing' : 'attached' }
}
