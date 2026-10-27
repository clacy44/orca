export const INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000

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
}): { stop: () => void } {
  let running = false
  const tick = async (): Promise<void> => {
    if (running) {
      return
    }
    running = true
    try {
      for (const accountId of options.listInactiveAccountIds()) {
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
  const timer = setInterval(
    () => void tick(),
    options.intervalMs ?? INACTIVE_TOKEN_KEEPALIVE_INTERVAL_MS
  )
  // Why: the keep-alive must never hold the process open on quit.
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
