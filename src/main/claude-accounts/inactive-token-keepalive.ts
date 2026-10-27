export const INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
// Why: a first pass shortly after launch, so a machine that is rarely on for 6 h still refreshes.
export const INACTIVE_TOKEN_KEEPALIVE_FIRST_TICK_MS = 5 * 60 * 1000

/**
 * Keeps non-active accounts' single-use refresh tokens from aging out unused.
 *
 * Refreshes the token only (through the lock-holding preparer) and never fetches usage, so a
 * long-idle account stays switch-able without spending the usage endpoint's request budget.
 */
export function startInactiveTokenKeepAlive(options: {
  listInactiveAccountIds: () => readonly string[]
  prepare: (accountId: string) => Promise<unknown>
  intervalMs?: number
  firstTickDelayMs?: number
}): { stop: () => void } {
  let running = false
  let stopped = false
  const tick = async (): Promise<void> => {
    if (running) {
      return
    }
    running = true
    try {
      for (const accountId of options.listInactiveAccountIds()) {
        // Why: a stop (quit) mid-tick must not start the next account's refresh.
        if (stopped) {
          break
        }
        try {
          await options.prepare(accountId)
        } catch (error) {
          console.warn('[claude-keepalive] Failed to refresh an inactive account token:', error)
        }
      }
    } finally {
      running = false
    }
  }
  // Why unref: the keep-alive must never hold the process open on quit.
  const first = setTimeout(
    () => void tick(),
    options.firstTickDelayMs ?? INACTIVE_TOKEN_KEEPALIVE_FIRST_TICK_MS
  )
  first.unref?.()
  const timer = setInterval(
    () => void tick(),
    options.intervalMs ?? INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS
  )
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    }
  }
}
