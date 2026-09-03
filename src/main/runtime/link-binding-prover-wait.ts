// Ruling 28(c) (C8a): the prover's one-shot settle-wait registry, split out of
// link-binding-prover.ts (Ruling 23(m)'s own precedent — a split is the only remedy for the
// 300-line gate, no baseline entry) — `createLinkBindingProver` is the only caller. A one-shot
// promise per linkDeviceId, resolved 'settled' the next time a round evaluates that link
// (`notifySettled`, called from the round's own `.then()`), or 'timeout' after `timeoutMs`.
// Never persisted — a restart simply has no waiters yet.
export type SettleWaitRegistry = {
  notifySettled(linkDeviceId: string): void
  waitForSettle(linkDeviceId: string, timeoutMs: number): Promise<'settled' | 'timeout'>
}

export function createSettleWaitRegistry(): SettleWaitRegistry {
  const waiters = new Map<string, Set<() => void>>()
  return {
    notifySettled(linkDeviceId: string): void {
      const set = waiters.get(linkDeviceId)
      if (!set) {
        return
      }
      waiters.delete(linkDeviceId)
      for (const resolve of set) {
        resolve()
      }
    },
    waitForSettle(linkDeviceId: string, timeoutMs: number): Promise<'settled' | 'timeout'> {
      return new Promise((resolve) => {
        const resolveOnce = (): void => {
          clearTimeout(timer)
          resolve('settled')
        }
        let set = waiters.get(linkDeviceId)
        if (!set) {
          set = new Set()
          waiters.set(linkDeviceId, set)
        }
        set.add(resolveOnce)
        const timer = setTimeout(() => {
          const current = waiters.get(linkDeviceId)
          current?.delete(resolveOnce)
          if (current && current.size === 0) {
            waiters.delete(linkDeviceId)
          }
          resolve('timeout')
        }, timeoutMs)
        timer.unref?.()
      })
    }
  }
}
