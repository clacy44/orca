// Why a store-free module: pty-dispatcher/pty-transport import this, and the store imports them back.
export type DaemonSessionsLostPayload = {
  epoch: number
  sessions: { id: string; paneKey: string | null; reanchor: boolean }[]
}

// Why a registry: a bound pane owns the generation/instance fencing for its recovery request; false means it declined (stale or disposed).
export type DaemonSessionLostInfo = { reanchor: boolean; paneKeys: string[] }
export const ptyDaemonSessionLostHandlers = new Map<
  string,
  (info: DaemonSessionLostInfo) => boolean
>()

// Why a mark: the re-anchor prompt may fire only on the daemon-session-lost recovery relaunch, never on a reveal or wake.
const RELAUNCH_MARK_TTL_MS = 2 * 60_000
const relaunchMarks = new Map<string, number>()

export function markDaemonSessionLostRelaunch(paneKeys: readonly string[]): void {
  for (const paneKey of paneKeys) {
    relaunchMarks.set(paneKey, Date.now())
  }
}

export function isDaemonSessionLostRelaunch(paneKey: string): boolean {
  const markedAt = relaunchMarks.get(paneKey)
  return markedAt !== undefined && Date.now() - markedAt < RELAUNCH_MARK_TTL_MS
}

export function consumeDaemonSessionLostRelaunch(paneKey: string): void {
  relaunchMarks.delete(paneKey)
}

export function _resetDaemonSessionLostRelaunchForTests(): void {
  relaunchMarks.clear()
}
