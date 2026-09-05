// S10-21a C7 (design v3.2 §2.1a): the main-process restore sweep's own lock — an in-process
// mutex held for the sweep's FULL duration, never wired as `ipcMain.handle` (§2.1: "not via the
// renderer-invoked recovery handler"). This is what makes "ordered in main before any renderer
// restore can act" a mechanism rather than a hope (§2.1a's own words): nothing else is allowed
// to touch a registered pane while the sweep runs.
//
// Scope, deliberately narrow (T24): held module-level state, not exported as a class, because
// there is exactly one sweep per process lifetime (§2.9: one pass, at startup) — a second
// `runRestoreSweep` call in the same generation is a structural no-op by construction (the sweep
// itself is idempotent per-pane via the durable marks, agent-sweep-restore-marks.ts), but the
// LOCK still serialises any concurrent attempt rather than assuming single-call discipline.
const SWEEP_LOCK_BOUND_MS = 30_000

let held = false
let heldSince: number | null = null
let boundTimer: ReturnType<typeof setTimeout> | null = null
// [S10-21a C7b, D-R110 finding 5, Ruling 34 Addendum 22] What `pty:spawn`'s own covered-launch
// wait resolves against — a fresh promise per acquisition, resolved by `releaseRestoreSweepLock`.
let releaseWaiters: (() => void)[] = []

/** T24's fence point: any renderer-invoked restore/recovery path reaching a create for a
 * registered pane while the sweep holds this must consult it and refuse (createTerminal's E1,
 * orca-runtime.ts) rather than race the sweep for the same pane key. */
export function isRestoreSweepLockHeld(): boolean {
  return held
}

/** [S10-21a C7b, D-R110 finding 5] The renderer's OWN restore path (`pty:spawn`) must never be
 * hard-refused by the sweep's lock — it waits, bounded by the same `SWEEP_LOCK_BOUND_MS` the
 * lock itself is held for at most, then proceeds regardless (never blocks a launch forever). A
 * caller times out ONLY if the lock is still held after the bound; the timeout is generous by
 * construction because the sweep's own overrun log fires at the exact same bound. */
export async function awaitRestoreSweepLockRelease(): Promise<'released' | 'not-held' | 'timeout'> {
  if (!held) {
    return 'not-held'
  }
  return await new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve('timeout')
      }
    }, SWEEP_LOCK_BOUND_MS)
    timer.unref?.()
    releaseWaiters.push(() => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve('released')
      }
    })
  })
}

/** Acquired once, for the sweep's whole run. Re-entrant acquisition (a second sweep pass, or a
 * test double calling twice) throws rather than silently granting a second holder — the design's
 * "an in-process mutex held across the whole sweep" is a single-holder primitive, not a
 * re-entrant one; a caller that needs a second pass must release the first. */
export function acquireRestoreSweepLock(): void {
  if (held) {
    throw new Error('restore_sweep_lock_already_held')
  }
  held = true
  heldSince = Date.now()
  // [§2.1a "30 s bound with a loud HARNESS-style audit if exceeded"] Loud, not fail-closed on
  // its own: exceeding the bound is a diagnostic (the sweep is taking pathologically long, e.g.
  // an inventory round hanging), not itself a reason to release the lock out from under a sweep
  // that may still be making progress — releasing early would reopen exactly the race §2.1a
  // exists to close. `console.error` so it lands in the VPS service journal (§2.6 precedent).
  boundTimer = setTimeout(() => {
    console.error(
      `[restore-sweep] HARNESS: sweep lock held past its ${SWEEP_LOCK_BOUND_MS}ms bound — ` +
        `the sweep is still running or a caller failed to release the lock.`
    )
  }, SWEEP_LOCK_BOUND_MS)
  boundTimer.unref?.()
}

export function releaseRestoreSweepLock(): void {
  held = false
  heldSince = null
  if (boundTimer) {
    clearTimeout(boundTimer)
    boundTimer = null
  }
  const waiters = releaseWaiters
  releaseWaiters = []
  for (const resolveWaiter of waiters) {
    resolveWaiter()
  }
}

/** Test-only introspection — no production caller. */
export function _restoreSweepLockHeldSinceForTest(): number | null {
  return heldSince
}

/** Test-only reset — clears state a prior test's throw may have left held. No production
 * caller: production releases only through `releaseRestoreSweepLock`'s own `finally`. */
export function _resetRestoreSweepLockForTest(): void {
  held = false
  heldSince = null
  if (boundTimer) {
    clearTimeout(boundTimer)
    boundTimer = null
  }
  releaseWaiters = []
}
