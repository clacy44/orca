// R326: the manual "Restart daemon" kills every pty of the old terminal host, then announces them
// through R315's session-loss handler once the NEW provider is bound. Until then the exit of each
// killed pty is HELD: recorded here, never forwarded (a forwarded exit would close the pane, and its
// main-side semantics would destroy the live status the renderer must capture first).
//
// Pure state only: pty.ts owns the wiring (exit listener, `pty:hasPty`, the `pty:spawn` fence).
export type HeldPtyExit = { id: string; incarnationId?: string }

export type RestartExitHoldRelease = {
  /** The held ids that actually exited (the old adapter's synthetic exits), with their incarnation. */
  captured: HeldPtyExit[]
  /** Ends the hold: ids stop being held and fenced spawns proceed. Call after the announcement ran. */
  settle: () => void
}

export type RestartExitHold = {
  /** `merged` is true when a hold was already open and these ids joined it (it must not happen: restarts coalesce). */
  begin: (ids: Iterable<string>) => { merged: boolean }
  isHeld: (id: string) => boolean
  /** Records the exit when `id` is held; returns whether it was (and so must not be forwarded). */
  captureIfHeld: (payload: HeldPtyExit) => boolean
  /** The promise a fenced spawn waits on, or null when no hold is open (so callers add no await). */
  pendingSettle: () => Promise<void> | null
  /** Takes the captured exits; null when no hold is open or it was already released (double release). */
  release: () => RestartExitHoldRelease | null
}

export function createRestartExitHold(): RestartExitHold {
  let heldIds: Set<string> | null = null
  let captured = new Map<string, HeldPtyExit>()
  let settled: Promise<void> | null = null
  let resolveSettled: (() => void) | null = null
  let released = false

  const begin: RestartExitHold['begin'] = (ids) => {
    if (heldIds) {
      for (const id of ids) {
        heldIds.add(id)
      }
      return { merged: true }
    }
    heldIds = new Set(ids)
    captured = new Map()
    released = false
    settled = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    return { merged: false }
  }

  const captureIfHeld: RestartExitHold['captureIfHeld'] = ({ id, incarnationId }) => {
    if (!heldIds?.has(id)) {
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
    if (!heldIds || released) {
      return null
    }
    released = true
    const mine = settled
    return {
      captured: [...captured.values()],
      settle: () => {
        // Why: a stale settle (from a hold that already ended) must not end a newer hold.
        if (settled !== mine) {
          return
        }
        const resolve = resolveSettled
        heldIds = null
        captured = new Map()
        settled = null
        resolveSettled = null
        resolve?.()
      }
    }
  }

  return {
    begin,
    isHeld: (id) => heldIds?.has(id) ?? false,
    captureIfHeld,
    pendingSettle: () => settled,
    release
  }
}
