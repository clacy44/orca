// R326: the manual "Restart daemon" kills every pty of the old terminal host, then announces them
// through R315's session-loss handler once the NEW provider is bound. The restart opens a WINDOW:
//   fenced phase  (closeFence .. begin): local spawns wait; spawns already past the fence drain;
//   held phase    (begin .. settle):     the exits of the killed ptys are HELD (recorded, never
//                 forwarded: a forwarded exit closes the pane, and its main-side semantics destroy
//                 the live status the renderer must capture first).
// A spawn that passed the fence holds a ticket; a snapshot (begin) marks outstanding tickets stale so
// a spawn that completes after the snapshot can be rejected instead of surviving unannounced.
//
// Pure state only: pty.ts owns the wiring (exit listener, `pty:hasPty`, the `pty:spawn` fence).
// Shown when a spawn loses a race with a manual restart (a retired adapter, or a late completion).
export const RESTART_SUPERSEDED_SPAWN_MESSAGE =
  'The terminal host restarted while this terminal was starting. Open it again.'

export type HeldPtyExit = { id: string; incarnationId?: string }

export type RestartSpawnTicket = {
  /** The snapshot generation current when the spawn passed the fence. */
  generation: number
  /** Idempotent: the spawn no longer counts as past the fence. */
  leave: () => void
}

export type RestartExitHoldRelease = {
  /** The held ids that actually exited (the old adapter's synthetic exits), with their incarnation. */
  captured: HeldPtyExit[]
  /** True for a held id whose exit arrived AFTER release: it was forwarded, so it must not be announced. */
  isLateExit: (id: string) => boolean
  /** Ends the window: ids stop being held and fenced spawns proceed. Call after the announcement ran. */
  settle: () => void
}

export type RestartExitHold = {
  /** Opens the window (fenced phase). `merged` is true when one was already open (a tripwire: restarts coalesce). */
  closeFence: () => { merged: boolean }
  /** A ticket when no window is open (check and increment are one synchronous step), else null. */
  tryPassFence: (inFlightId: string | null) => RestartSpawnTicket | null
  /** Resolves when no ticket is outstanding, or at the timeout. Never rejects. */
  awaitDrain: (timeoutMs: number) => Promise<{ drained: boolean; pending: number }>
  /** The snapshot: holds `ids`, bumps the generation and marks outstanding tickets stale. */
  begin: (ids: Iterable<string>) => { merged: boolean }
  snapshotGeneration: () => number
  /** Tickets of this in-flight id that a snapshot already superseded. */
  staleSpawnCount: (inFlightId: string) => number
  isHeld: (id: string) => boolean
  /** Records the exit when `id` is held and not yet released; false means forward it normally. */
  captureIfHeld: (payload: HeldPtyExit) => boolean
  /** The promise a fenced spawn waits on, or null when no window is open (so callers add no await). */
  pendingSettle: () => Promise<void> | null
  /** Takes the captured exits; null when no window is open or it was already released. */
  release: () => RestartExitHoldRelease | null
}

type TicketState = { inFlightId: string | null; stale: boolean }

export function createRestartExitHold(): RestartExitHold {
  let windowOpen = false
  let heldIds: Set<string> | null = null
  let captured = new Map<string, HeldPtyExit>()
  let lateExited = new Set<string>()
  let settled: Promise<void> | null = null
  let resolveSettled: (() => void) | null = null
  let released = false
  let generation = 0
  const tickets = new Set<TicketState>()
  const staleById = new Map<string, number>()
  let drainWaiters: (() => void)[] = []

  const openWindow = (): void => {
    windowOpen = true
    heldIds = null
    captured = new Map()
    lateExited = new Set()
    released = false
    settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
  }

  const wakeDrainWaiters = (): void => {
    const waiters = drainWaiters
    drainWaiters = []
    for (const wake of waiters) {
      wake()
    }
  }

  const closeFence: RestartExitHold['closeFence'] = () => {
    if (windowOpen) {
      return { merged: true }
    }
    openWindow()
    return { merged: false }
  }

  const tryPassFence: RestartExitHold['tryPassFence'] = (inFlightId) => {
    if (windowOpen) {
      return null
    }
    const state: TicketState = { inFlightId, stale: false }
    tickets.add(state)
    let left = false
    return {
      generation,
      leave: () => {
        if (left) {
          return
        }
        left = true
        tickets.delete(state)
        if (state.stale && state.inFlightId) {
          const remaining = (staleById.get(state.inFlightId) ?? 1) - 1
          if (remaining > 0) {
            staleById.set(state.inFlightId, remaining)
          } else {
            staleById.delete(state.inFlightId)
          }
        }
        if (tickets.size === 0) {
          wakeDrainWaiters()
        }
      }
    }
  }

  const awaitDrain: RestartExitHold['awaitDrain'] = (timeoutMs) => {
    if (tickets.size === 0) {
      return Promise.resolve({ drained: true, pending: 0 })
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const wake = (): void => {
        if (timer) {
          clearTimeout(timer)
        }
        resolve({ drained: tickets.size === 0, pending: tickets.size })
      }
      timer = setTimeout(() => {
        drainWaiters = drainWaiters.filter((waiter) => waiter !== wake)
        wake()
      }, timeoutMs)
      drainWaiters.push(wake)
    })
  }

  const begin: RestartExitHold['begin'] = (ids) => {
    const merged = windowOpen && heldIds !== null
    if (!windowOpen) {
      openWindow()
    }
    heldIds ??= new Set()
    for (const id of ids) {
      heldIds.add(id)
    }
    generation += 1
    for (const ticket of tickets) {
      if (ticket.stale) {
        continue
      }
      ticket.stale = true
      if (ticket.inFlightId) {
        staleById.set(ticket.inFlightId, (staleById.get(ticket.inFlightId) ?? 0) + 1)
      }
    }
    return { merged }
  }

  const captureIfHeld: RestartExitHold['captureIfHeld'] = ({ id, incarnationId }) => {
    if (!heldIds?.has(id)) {
      return false
    }
    if (released) {
      // Why: after release the exit is forwarded as today's exit; the announcement must skip this id.
      lateExited.add(id)
      return false
    }
    const existing = captured.get(id)
    // Why: the daemon-protocol fanout can report one id twice (with and without its incarnation);
    // the incarnation is what lets the announcement's currency check recognise the id.
    if (!existing || (!existing.incarnationId && incarnationId)) {
      captured.set(id, { id, ...(incarnationId ? { incarnationId } : {}) })
    }
    return true
  }

  const release: RestartExitHold['release'] = () => {
    if (!windowOpen || released) {
      return null
    }
    released = true
    const mine = settled
    const lateExitedAtRelease = lateExited
    return {
      captured: [...captured.values()],
      isLateExit: (id) => lateExitedAtRelease.has(id),
      settle: () => {
        // Why: a stale settle (from a window that already ended) must not end a newer window.
        if (settled !== mine) {
          return
        }
        const resolve = resolveSettled
        windowOpen = false
        heldIds = null
        captured = new Map()
        lateExited = new Set()
        settled = null
        resolveSettled = null
        resolve?.()
      }
    }
  }

  return {
    closeFence,
    tryPassFence,
    awaitDrain,
    begin,
    snapshotGeneration: () => generation,
    staleSpawnCount: (inFlightId) => staleById.get(inFlightId) ?? 0,
    isHeld: (id) => heldIds?.has(id) ?? false,
    captureIfHeld,
    pendingSettle: () => settled,
    release
  }
}
