// Why: high-frequency PTY-driven churn fanned out per client is one problem shape, not several — the
// part a bespoke timer per surface always omits is the max-wait cap, without which sustained churn
// starves the emit forever.

export type KeyedTrailingEdgeCoalescer = {
  // Schedule a coalesced (trailing-edge) emit for a key.
  schedule: (key: string) => void
  // Cancel a key's pending emit without firing. Use when an immediate emit has already superseded
  // the pending state, or the key is gone and a stale emit must not fire.
  cancel: (key: string) => void
  // Fire a key's pending emit now (only if one is pending).
  flush: (key: string) => void
  // Fire every pending key now.
  flushAll: () => void
  // Drop all pending state without emitting (teardown).
  dispose: () => void
}

export type KeyedTrailingEdgeCoalescerOptions = {
  // Trailing-edge window: each schedule inside it restarts the wait.
  windowMs: number
  // Total delay cap, so a key that keeps churning still emits within this budget.
  maxWaitMs: number
}

type PendingEmit = {
  timer: ReturnType<typeof setTimeout>
  firstScheduledAt: number
}

/**
 * Coalesces per-key emits on a short trailing-edge window. `emit` is invoked once per settled key
 * and is expected to read the latest state itself, so only the freshest version is ever published.
 */
export function createKeyedTrailingEdgeCoalescer(
  emit: (key: string) => void,
  options: KeyedTrailingEdgeCoalescerOptions
): KeyedTrailingEdgeCoalescer {
  const pending = new Map<string, PendingEmit>()

  const clear = (key: string): void => {
    const entry = pending.get(key)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(key)
  }

  const fire = (key: string): void => {
    clear(key)
    emit(key)
  }

  const arm = (key: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => fire(key), options.windowMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return timer
  }

  return {
    schedule(key: string): void {
      const now = Date.now()
      const existing = pending.get(key)
      if (existing) {
        // Cap total delay so sustained churn can't starve the emit forever.
        if (now - existing.firstScheduledAt >= options.maxWaitMs) {
          fire(key)
          return
        }
        clearTimeout(existing.timer)
        existing.timer = arm(key)
        return
      }
      pending.set(key, { timer: arm(key), firstScheduledAt: now })
    },
    cancel(key: string): void {
      clear(key)
    },
    flush(key: string): void {
      if (pending.has(key)) {
        fire(key)
      }
    },
    flushAll(): void {
      // Snapshot keys first: fire() deletes from `pending`, and emit may schedule new work, so
      // mutating the live map mid-iteration is unsafe.
      const keys = Array.from(pending.keys())
      for (const key of keys) {
        fire(key)
      }
    },
    dispose(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
      }
      pending.clear()
    }
  }
}
