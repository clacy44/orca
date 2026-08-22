// Why a pure resolver beside the component: the four-state ladder is the part with rules (typing outranks
// writing, a hold outranks both, `self` is never a peer), and it must be assertable without a DOM.
import type {
  TerminalPanePresence,
  TerminalPresenceParticipant
} from '@/lib/pane-manager/terminal-presence-state'

export type TerminalPresenceChipActivity = 'attached' | 'writing' | 'typing' | 'held'

export type TerminalPresenceChipState = {
  label: string
  activity: TerminalPresenceChipActivity
}

// Why typing outranks writing: the interactive stamp is the one that can hold your keystroke, so a
// participant doing both must read as the state with consequences.
function activityRank(participant: TerminalPresenceParticipant): number {
  if (participant.typing) {
    return 2
  }
  return participant.writing ? 1 : 0
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
  if (peer.typing) {
    return { label: peer.label, activity: 'typing' }
  }
  return { label: peer.label, activity: peer.writing ? 'writing' : 'attached' }
}
