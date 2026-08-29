import type { RuntimeClient } from '../runtime-client'

/**
 * S9 design §2d (closure principle): the entry point that started a session owns it. `orca lane
 * login` starts a host-inline session on this terminal, so if the terminal goes away before a
 * code is captured, THIS process — never the 180s TTL — must release it, the same way
 * `interactive-login-interruption.ts` does for the child-process `account add` flow.
 *
 * Wired triggers: SIGINT/SIGTERM/SIGHUP (Windows has no SIGHUP; its Ctrl-C arrives as SIGINT via
 * the console, so registering it is harmless there), the readline prompt's own abort (unblocks a
 * pending `rl.question()` so its `finally` can run), and the prompt's `'close'` event (stdin
 * ending — Ctrl-D, or a closed pipe — which otherwise leaves `rl.question()` pending forever).
 */

const LANE_LOGIN_INTERRUPT_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
}
const LANE_LOGIN_INTERRUPT_SIGNALS = Object.keys(
  LANE_LOGIN_INTERRUPT_EXIT_CODES
) as NodeJS.Signals[]

export type LaneLoginInterruptGuard = {
  /** Pass as `rl.question(query, { signal })` so an interrupt unblocks a pending prompt. */
  signal: AbortSignal
  /** Attach to the current prompt's `rl.on('close', ...)`; detach again before this same call
   *  closes that `rl` itself, or its own cleanup would look like an interrupt. */
  onReadlineClose: () => void
  /** True once `signal` has fired — the caller's own `await` should swallow the resulting
   *  rejection instead of surfacing it, since this guard is already exiting the process. */
  isAborting(): boolean
  /** Call around each `loginSubmitCodeInline`: a code already handed to the runtime is never
   *  cancelled out from under itself — it may already be mid-turn. */
  markSubmitting(submitting: boolean): void
  /** Detaches every listener this guard registered. Always call in a `finally`. */
  dispose(): void
}

/** Arms interrupt handling for a host-inline login session already started on `principalId`. */
export function armLaneLoginInterruptGuard(
  client: RuntimeClient,
  principalId: string
): LaneLoginInterruptGuard {
  const controller = new AbortController()
  let submitting = false
  let handled = false

  const cancelSession = async (): Promise<void> => {
    if (submitting) {
      return
    }
    try {
      await client.call('accounts.lane.loginCancelInline', { principalId })
    } catch {
      // Best effort: the process is exiting regardless of whether this lands.
    }
  }

  const onInterrupt = (signal?: NodeJS.Signals): void => {
    if (handled) {
      return
    }
    handled = true
    controller.abort()
    void cancelSession().finally(() => {
      console.log('Login cancelled.')
      process.exit(signal ? (LANE_LOGIN_INTERRUPT_EXIT_CODES[signal] ?? 1) : 1)
    })
  }

  // Why: repeated signals must keep awaiting the same cancel, never restore Node's defaults.
  for (const signal of LANE_LOGIN_INTERRUPT_SIGNALS) {
    process.on(signal, onInterrupt)
  }

  return {
    signal: controller.signal,
    onReadlineClose: () => onInterrupt(),
    isAborting: () => controller.signal.aborted,
    markSubmitting(value: boolean) {
      submitting = value
    },
    dispose() {
      for (const signal of LANE_LOGIN_INTERRUPT_SIGNALS) {
        process.off(signal, onInterrupt)
      }
    }
  }
}
