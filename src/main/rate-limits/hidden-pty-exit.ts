import { cleanupHiddenRateLimitPty, type HiddenPty, type PtyDisposable } from './hidden-pty-cleanup'

/**
 * Killing a hidden probe and WAITING for it — §2f's close-wipe fence, host side.
 *
 * `cleanupHiddenRateLimitPty`'s kill arm posts a signal and returns, so a fetch that resolves on
 * it hands the lane lifecycle a fence that is open: the swept lane can still have
 * `.credentials.json` written back by a `claude` finishing a token rotation. This waits for the
 * pty's own exit, escalates to `SIGKILL` once, and reports whether the process was confirmed gone
 * so a caller that cannot confirm it refuses to report the wipe done.
 */

/** The message a fetch settles with when its hidden `claude` was never confirmed gone. */
export const HIDDEN_PTY_KILL_UNCONFIRMED_ERROR =
  'Rate-limit fetch aborted; the hidden Claude process could not be confirmed dead'

export type HiddenPtyKillOutcome = 'exited' | 'timed-out'

/** SIGHUP first, then SIGKILL, then give up — each bound, so no caller waits unbounded. */
const HIDDEN_PTY_EXIT_GRACE_MS = 2_000
const HIDDEN_PTY_ESCALATED_GRACE_MS = 3_000

export type HiddenPtyKillOptions = {
  graceMs?: number
  escalatedGraceMs?: number
  platform?: NodeJS.Platform
}

export function killHiddenRateLimitPtyAwaitingExit(
  term: HiddenPty,
  disposables: PtyDisposable[],
  options: HiddenPtyKillOptions = {}
): Promise<HiddenPtyKillOutcome> {
  const platform = options.platform ?? process.platform
  const graceMs = options.graceMs ?? HIDDEN_PTY_EXIT_GRACE_MS
  const escalatedGraceMs = options.escalatedGraceMs ?? HIDDEN_PTY_ESCALATED_GRACE_MS
  return new Promise<HiddenPtyKillOutcome>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = []
    let exitSubscription: PtyDisposable | undefined
    let settled = false

    function finish(outcome: HiddenPtyKillOutcome): void {
      if (settled) {
        return
      }
      settled = true
      for (const timer of timers) {
        clearTimeout(timer)
      }
      disposeQuietly(exitSubscription)
      if (outcome === 'exited' || platform !== 'win32') {
        // The child is gone: only the listeners and the master fd are left to release.
        cleanupHiddenRateLimitPty(term, disposables, { kill: false })
      } else {
        // A win32 child that may still be running: `destroy()` kills the ConPTY a second time.
        for (const disposable of disposables.splice(0)) {
          disposable.dispose()
        }
      }
      resolve(outcome)
    }

    exitSubscription = subscribeExit(term, () => finish('exited'))
    if (!killQuietly(term)) {
      // node-pty throws on a child that has already gone.
      finish('exited')
      return
    }
    // Unref'd: a pending escalation must not hold the process open at quit.
    timers.push(
      unref(
        setTimeout(() => {
          // node-pty's Windows kill ignores the signal and takes the whole tree, so it is never
          // re-issued there — the double kill is the ConPTY double-close this module avoids.
          if (platform !== 'win32') {
            killQuietly(term, 'SIGKILL')
          }
        }, graceMs)
      )
    )
    timers.push(unref(setTimeout(() => finish('timed-out'), graceMs + escalatedGraceMs)))
  })
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  timer.unref?.()
  return timer
}

function subscribeExit(term: HiddenPty, onExit: () => void): PtyDisposable | undefined {
  try {
    return term.onExit?.(onExit) ?? undefined
  } catch {
    return undefined
  }
}

function killQuietly(term: HiddenPty, signal?: string): boolean {
  try {
    term.kill(signal)
    return true
  } catch {
    return false
  }
}

function disposeQuietly(disposable: PtyDisposable | undefined): void {
  try {
    disposable?.dispose()
  } catch {
    /* already torn down */
  }
}
