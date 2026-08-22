// Why: presence changes once per keystroke but is fanned out per subscriber, so every surface reads one
// coalesced per-PTY feed instead of arming its own timer — including the TTL falling edge, which is the
// one emit no mutation produces and which a per-surface timer would therefore forget.
import { createKeyedTrailingEdgeCoalescer } from './keyed-trailing-edge-coalescer'
import {
  terminalPresenceRegistry,
  type TerminalPresenceRegistry
} from './terminal-presence-registry'
import {
  TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
  isTerminalPresenceActivityFresh
} from './terminal-presence-activity-rows'

// Why: a keystroke burst must publish at human speed, not at PTY speed. 750 ms is below the 3 s activity
// TTL so a chip lights well inside its own window, and the 3x max-wait keeps a sustained typist visible.
export const TERMINAL_PRESENCE_COALESCE_WINDOW_MS = 750
export const TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS = 2250

export type TerminalPresenceChangeNotifier = {
  subscribe: (ptyId: string, listener: () => void) => () => void
  dispose: () => void
}

export type TerminalPresenceChangeNotifierOptions = {
  registry: TerminalPresenceRegistry
  // Why: presence's single clock domain, injectable alongside the registry's so one fake clock drives
  // the stamps and the falling edge that expires them.
  now?: () => number
}

export function createTerminalPresenceChangeNotifier(
  options: TerminalPresenceChangeNotifierOptions
): TerminalPresenceChangeNotifier {
  const { registry } = options
  // Why the registry's clock by default: the falling edge exists to expire stamps this registry wrote,
  // so reading a second clock would arm timers against timestamps from a different domain.
  const now = options.now ?? ((): number => registry.now())
  const listenersByPty = new Map<string, Set<() => void>>()
  const fallingEdgeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Why the earliest and not the latest: each participant's flag expires on its own stamp, so arming off
  // the freshest one leaves everybody who typed earlier published as typing until the newest stamp dies —
  // up to a full TTL late. Already-expired stamps are skipped; the re-arm after each emit collapses the rest.
  const earliestFreshActivityAt = (ptyId: string, at: number): number | null => {
    let earliest: number | null = null
    const consider = (stamp: number): void => {
      if (isTerminalPresenceActivityFresh(stamp, at) && (earliest === null || stamp < earliest)) {
        earliest = stamp
      }
    }
    for (const attachment of registry.attachmentsOf(ptyId).values()) {
      consider(attachment.lastInteractiveInputAt)
    }
    for (const lastGrantWriteAt of registry.grantWritesOf(ptyId).values()) {
      consider(lastGrantWriteAt)
    }
    return earliest
  }

  const clearFallingEdge = (ptyId: string): void => {
    const timer = fallingEdgeTimers.get(ptyId)
    if (timer) {
      clearTimeout(timer)
      fallingEdgeTimers.delete(ptyId)
    }
  }

  // Why: activity expiry is a state change no mutator reports, so the last published payload would keep a
  // dead "typing" on screen forever.
  function armFallingEdge(ptyId: string): void {
    const at = now()
    const earliest = earliestFreshActivityAt(ptyId, at)
    if (earliest === null) {
      return
    }
    const remaining = earliest + TERMINAL_PRESENCE_ACTIVITY_TTL_MS - at
    const timer = setTimeout(() => {
      fallingEdgeTimers.delete(ptyId)
      emit(ptyId)
    }, remaining)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    fallingEdgeTimers.set(ptyId, timer)
  }

  function emit(ptyId: string): void {
    clearFallingEdge(ptyId)
    const listeners = listenersByPty.get(ptyId)
    if (!listeners?.size) {
      return
    }
    // Snapshot first: a listener may unsubscribe itself while the set is being walked.
    for (const listener of Array.from(listeners)) {
      listener()
    }
    armFallingEdge(ptyId)
  }

  const coalescer = createKeyedTrailingEdgeCoalescer(emit, {
    windowMs: TERMINAL_PRESENCE_COALESCE_WINDOW_MS,
    maxWaitMs: TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS
  })

  const unsubscribeRegistry = registry.onChange((ptyId) => {
    // Why: a solo host pays nothing — no subscriber on this PTY means no timer is ever armed for it.
    if (!listenersByPty.get(ptyId)?.size) {
      return
    }
    coalescer.schedule(ptyId)
  })

  return {
    subscribe(ptyId: string, listener: () => void): () => void {
      let listeners = listenersByPty.get(ptyId)
      if (!listeners) {
        listeners = new Set()
        listenersByPty.set(ptyId, listeners)
      }
      listeners.add(listener)
      // Why on join and not only on emit: both handlers publish their first payload themselves, and a
      // stamp landed while this PTY had no subscriber schedules nothing — so a stream opening inside
      // somebody's TTL would render them typing with no expiry emit behind it, forever. Cleared first:
      // arming twice would strand the older timer and double every expiry emit.
      clearFallingEdge(ptyId)
      armFallingEdge(ptyId)
      return () => {
        const current = listenersByPty.get(ptyId)
        if (!current?.delete(listener) || current.size > 0) {
          return
        }
        listenersByPty.delete(ptyId)
        coalescer.cancel(ptyId)
        clearFallingEdge(ptyId)
      }
    },
    dispose(): void {
      unsubscribeRegistry()
      coalescer.dispose()
      for (const ptyId of Array.from(fallingEdgeTimers.keys())) {
        clearFallingEdge(ptyId)
      }
      listenersByPty.clear()
    }
  }
}

// Why: one notifier per host process, bound to the one registry every stamp site writes.
export const terminalPresenceChangeNotifier = createTerminalPresenceChangeNotifier({
  registry: terminalPresenceRegistry
})
