// Why its own module: the runtime-wide roster is a broadcast, so the one thing that must not live in
// the fan-out is the decision of WHEN to broadcast. Membership is derived from the same registry the
// per-keystroke stamps write, and the only structural way to keep a keystroke off this bus is to
// compare the built payload with the last published one — which needs state no emit site owns.
import type {
  RuntimeTerminalPresenceClientEvent,
  RuntimeTerminalPresenceParticipant
} from '../../shared/runtime-client-events'
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import {
  TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS,
  TERMINAL_PRESENCE_COALESCE_WINDOW_MS
} from './terminal-presence-change-notifier'
import type { TerminalPresenceRegistry } from './terminal-presence-registry'
import { nextMobilePresenceStaleAt } from './terminal-presence-staleness'

// Why one key: this bus is runtime-wide, so the coalescer that guards it has exactly one stream to
// guard. Keeping the keyed contract (rather than hand-rolling a single timer) is what buys the
// max-wait starvation cap for free.
const ROSTER_COALESCER_KEY = 'roster'

export type TerminalPresenceRosterMembership = {
  participants: RuntimeTerminalPresenceParticipant[]
  truncated?: true
}

export type TerminalPresenceRosterPublisherOptions = {
  registry: TerminalPresenceRegistry
  // Why a callback and not a snapshot: the coalescer fires on the trailing edge, so the payload must
  // be built when it settles, never when it was scheduled.
  buildMembership: () => TerminalPresenceRosterMembership
  publish: (event: RuntimeTerminalPresenceClientEvent) => void
}

export type TerminalPresenceRosterPublisher = {
  // Membership may have changed; publish on the trailing edge if it actually did.
  schedule: () => void
  // Fire a pending publish now (tests and teardown; a real change still has to pass the diff).
  flush: () => void
  // The current roster as a subscribe-time snapshot. Does not publish and does not advance `seq` —
  // see the broadcast-only contract on the RuntimeClientEvent declaration; nothing may order on it.
  snapshot: () => RuntimeTerminalPresenceClientEvent
  dispose: () => void
}

function toEvent(
  membership: TerminalPresenceRosterMembership,
  seq: number
): RuntimeTerminalPresenceClientEvent {
  return {
    type: 'terminalPresence',
    seq,
    participants: membership.participants,
    ...(membership.truncated ? { truncated: true } : {})
  }
}

export function createTerminalPresenceRosterPublisher(
  options: TerminalPresenceRosterPublisherOptions
): TerminalPresenceRosterPublisher {
  let seq = 0
  // Why seeded rather than null: this publisher is created the moment a client subscribes, and that
  // client is handed the roster as a snapshot. Starting empty would republish that identical payload
  // to everybody as the new subscriber's "join", so the baseline is what a subscriber could already
  // have seen — and every later emit is a real change.
  let lastPublished: string | null = JSON.stringify(options.buildMembership())

  // Why this bus needs its own: a phone going quiet changes the roster while producing no registry
  // mutation at all, so the fingerprint above would keep publishing nothing and the status bar would
  // name a dead phone as freshly attached. Marks a row; never removes one.
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  const armStaleEdge = (): void => {
    if (staleTimer) {
      clearTimeout(staleTimer)
      staleTimer = null
    }
    const at = options.registry.now()
    const deadline = nextMobilePresenceStaleAt(options.registry, at)
    if (deadline === null) {
      return
    }
    staleTimer = setTimeout(() => {
      staleTimer = null
      emit()
    }, deadline - at)
    if (typeof staleTimer.unref === 'function') {
      staleTimer.unref()
    }
  }

  // Why compare the serialized payload rather than watch specific mutators: every field on a W8 row is
  // one a keystroke cannot move, so "the payload is byte-identical" IS "membership did not change" —
  // and a future field that a keystroke CAN move would light this bus up in a test rather than in
  // production. The registry's per-PTY feed fires on every interactive stamp; this is what absorbs it.
  const emit = (): void => {
    const membership = options.buildMembership()
    const fingerprint = JSON.stringify(membership)
    armStaleEdge()
    if (fingerprint === lastPublished) {
      return
    }
    lastPublished = fingerprint
    seq += 1
    options.publish(toEvent(membership, seq))
  }

  const coalescer = createKeyedTrailingEdgeCoalescer(() => emit(), {
    windowMs: TERMINAL_PRESENCE_COALESCE_WINDOW_MS,
    maxWaitMs: TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS
  })

  const schedule = (): void => {
    coalescer.schedule(ROSTER_COALESCER_KEY)
  }

  // Why both channels: attach/detach reaches the per-PTY feed, while join/leave belongs to no ptyId
  // and reaches the membership feed. Subscribing to one alone leaves half the roster stale.
  const unsubscribeChange = options.registry.onChange(schedule)
  const unsubscribeMembership = options.registry.onMembershipChange(schedule)
  // Why armed at construction and not only after the first publish: the seeded baseline above may
  // already contain a phone, whose staleness would otherwise wait for somebody else to move.
  armStaleEdge()

  return {
    schedule,
    flush(): void {
      coalescer.flush(ROSTER_COALESCER_KEY)
    },
    snapshot(): RuntimeTerminalPresenceClientEvent {
      // Why the live registry and not the last published payload: events emitted while a transport was
      // down are lost, not queued, so a (re)subscribe must see what is true now — not what the last
      // fan-out happened to carry.
      return toEvent(options.buildMembership(), seq)
    },
    dispose(): void {
      unsubscribeChange()
      unsubscribeMembership()
      coalescer.dispose()
      if (staleTimer) {
        clearTimeout(staleTimer)
        staleTimer = null
      }
      lastPublished = null
    }
  }
}
