// Why its own module: this is the one place presence stops being awareness and drops a human's
// keystroke, so the whole rule — who may arm a hold, who can never be held, and how long one nudge
// lasts — has to be readable and provable with no stream in sight.
import type { RuntimeTerminalStreamPresenceArbitration } from '../../shared/runtime-types'
import { isTerminalPresenceActivityFresh } from './terminal-presence-activity-rows'
import {
  HOST_ATTACHMENT_KEY,
  terminalPresenceRegistry,
  type TerminalPresenceAttachment,
  type TerminalPresenceRegistry
} from './terminal-presence-registry'
import { HOST_PARTICIPANT_ID } from './terminal-presence-snapshot'

// Why 5 s and not the 3 s activity TTL: this is a human reaction window — long enough to read the chip
// and press the key again, short enough that the prompt cannot outlive the collision that raised it.
export const ARBITRATION_REPROMPT_MS = 5000

type TerminalPresenceHoldRecord = {
  heldFor: string
  until: number
  // Why the record outlives the re-press instead of being deleted: it doubles as the "already nudged"
  // mark. Deleting it would let the second consult — the one inside the async claim tail — hold the very
  // keystroke that just earned its way through, and would re-nudge on every keystroke after that.
  released: boolean
}

type TypingPeer = { participantId: string; stamp: number }

type TerminalPresenceGrantIdentity = { grantKey: string; participantId: string }

export type TerminalPresenceArbitration = {
  /** The hold to publish on this grant's streams, or null when the keystroke may reach the PTY. */
  shouldHoldInputForTypingPeer: (
    ptyId: string,
    grantKey: string
  ) => RuntimeTerminalStreamPresenceArbitration | null
  /** Read-only: the notice every later emit on this grant's streams must carry, or null once it lapsed. */
  activeHoldNotice: (
    ptyId: string,
    grantKey: string
  ) => RuntimeTerminalStreamPresenceArbitration | null
  /** When this PTY's earliest un-retired notice stops being publishable, or null when none is. */
  nextHoldExpiryAt: (ptyId: string) => number | null
  reset: () => void
}

export function createTerminalPresenceArbitration(options: {
  registry: TerminalPresenceRegistry
}): TerminalPresenceArbitration {
  const { registry } = options
  const holdsByPty = new Map<string, Map<string, TerminalPresenceHoldRecord>>()

  // Why the durable grant and never participantId: a participant never gates against itself, so A's
  // second window answers to this same key and can never be held by A's first (§2.6). The local human
  // has no grant and answers to the same 'host' sentinel its reserved attachment key uses.
  const identify = (
    subscriptionKey: string,
    attachment: TerminalPresenceAttachment
  ): TerminalPresenceGrantIdentity | null => {
    if (subscriptionKey === HOST_ATTACHMENT_KEY || attachment.connectionId === null) {
      return { grantKey: HOST_PARTICIPANT_ID, participantId: HOST_PARTICIPANT_ID }
    }
    const participant = registry.getParticipantByConnection(attachment.connectionId)
    // Why a holder we cannot name is no holder at all: the notice carries a participantId, and a hold
    // whose reason the held client cannot render is an unexplained dropped keystroke.
    return participant
      ? { grantKey: participant.pairedDeviceId, participantId: participant.participantId }
      : null
  }

  // Why ONLY lastInteractiveInputAt: grant writes live in their own map, so an agent borrowing a
  // human's grant through terminal.send can never swallow that human's keystroke — site (d) is disarmed
  // by which map this opens, not by a rule an implementer has to remember (§2.6).
  const findTypingPeer = (ptyId: string, grantKey: string, now: number): TypingPeer | null => {
    let peer: TypingPeer | null = null
    for (const [subscriptionKey, attachment] of registry.attachmentsOf(ptyId)) {
      if (!isTerminalPresenceActivityFresh(attachment.lastInteractiveInputAt, now)) {
        continue
      }
      const identity = identify(subscriptionKey, attachment)
      if (!identity || identity.grantKey === grantKey) {
        continue
      }
      // Why a held peer holds nobody: their own last keystroke was DROPPED, so this stamp is intent that
      // never reached the PTY (§4.5 stamps before the gate). Counting it takes a character from the
      // incumbent too, on every ordinary collision. Their re-press releases the record and re-arms them.
      const held = holdsByPty.get(ptyId)?.get(identity.grantKey)
      if (held && !held.released && now < held.until) {
        continue
      }
      // Why the freshest stamp: with two peers typing, the collision the reader is asked to yield to is
      // the one still happening. Ties break on the id so two of one peer's windows cannot flip the name.
      const isLoudest =
        !peer ||
        attachment.lastInteractiveInputAt > peer.stamp ||
        (attachment.lastInteractiveInputAt === peer.stamp &&
          identity.participantId < peer.participantId)
      if (isLoudest) {
        peer = { participantId: identity.participantId, stamp: attachment.lastInteractiveInputAt }
      }
    }
    return peer
  }

  const forget = (ptyId: string, grantKey: string): void => {
    const byGrant = holdsByPty.get(ptyId)
    if (byGrant?.delete(grantKey) && byGrant.size === 0) {
      holdsByPty.delete(ptyId)
    }
  }

  // Why swept at hold time and nowhere else: a lapsed record carries no rule (it neither publishes a
  // notice nor suppresses a nudge), and holds for a PTY that has since exited are never consulted again,
  // so the rare path that adds one is the only place that has to walk the map.
  const sweepLapsed = (now: number): void => {
    for (const [ptyId, byGrant] of holdsByPty) {
      for (const [grantKey, record] of byGrant) {
        if (now >= record.until) {
          byGrant.delete(grantKey)
        }
      }
      if (byGrant.size === 0) {
        holdsByPty.delete(ptyId)
      }
    }
  }

  return {
    shouldHoldInputForTypingPeer(ptyId, grantKey) {
      const now = registry.now()
      const peer = findTypingPeer(ptyId, grantKey, now)
      if (!peer) {
        // Why cleared: the typist has gone quiet, so this episode is over and the next collision earns
        // its own nudge rather than inheriting a spent one.
        forget(ptyId, grantKey)
        return null
      }
      const record = holdsByPty.get(ptyId)?.get(grantKey)
      if (record && record.heldFor === peer.participantId && now < record.until) {
        // The re-press: one speed bump per collision. The window slides so a peer who keeps typing
        // through a long episode is never nudged twice about the same person.
        record.released = true
        record.until = now + ARBITRATION_REPROMPT_MS
        return null
      }
      sweepLapsed(now)
      const until = now + ARBITRATION_REPROMPT_MS
      let byGrant = holdsByPty.get(ptyId)
      if (!byGrant) {
        byGrant = new Map()
        holdsByPty.set(ptyId, byGrant)
      }
      byGrant.set(grantKey, { heldFor: peer.participantId, until, released: false })
      return { heldFor: peer.participantId, until }
    },
    activeHoldNotice(ptyId, grantKey) {
      const record = holdsByPty.get(ptyId)?.get(grantKey)
      if (!record || record.released || registry.now() >= record.until) {
        return null
      }
      return { heldFor: record.heldFor, until: record.until }
    },
    // Why the falling edge needs its own deadline from here: a hold outlives by 2 s the activity TTL that
    // raised it, so the notifier arming on stamps alone stops emitting while the notice is still being
    // published — and the last thing the held client ever hears is "press again".
    nextHoldExpiryAt(ptyId) {
      const now = registry.now()
      let earliest: number | null = null
      for (const record of holdsByPty.get(ptyId)?.values() ?? []) {
        // Released and lapsed records publish no notice, so they need no emit behind them; excluding the
        // lapsed one is also what stops an expiry emit from arming a timer for the deadline it just met.
        if (record.released || now >= record.until) {
          continue
        }
        if (earliest === null || record.until < earliest) {
          earliest = record.until
        }
      }
      return earliest
    },
    reset() {
      holdsByPty.clear()
    }
  }
}

// Why one arbitration per host process, bound to the one registry every stamp site writes: the hold is
// per (ptyId, grant) across every stream that grant holds, so a second instance would nudge twice.
const processArbitration = createTerminalPresenceArbitration({ registry: terminalPresenceRegistry })

export function shouldHoldInputForTypingPeer(
  ptyId: string,
  grantKey: string
): RuntimeTerminalStreamPresenceArbitration | null {
  return processArbitration.shouldHoldInputForTypingPeer(ptyId, grantKey)
}

export function activeTerminalPresenceHoldNotice(
  ptyId: string,
  grantKey: string
): RuntimeTerminalStreamPresenceArbitration | null {
  return processArbitration.activeHoldNotice(ptyId, grantKey)
}

export function nextTerminalPresenceHoldExpiryAt(ptyId: string): number | null {
  return processArbitration.nextHoldExpiryAt(ptyId)
}

/** Test-only: holds are process-global, so a case that armed one would otherwise leak into the next. */
export function resetTerminalPresenceArbitrationForTest(): void {
  processArbitration.reset()
}
