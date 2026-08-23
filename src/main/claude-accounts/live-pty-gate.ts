const liveClaudePtyIds = new Set<string>()
// Why: which credential lane each live pty was pinned to. A pty absent from this map is
// UNATTRIBUTED — seeded from persistence, or a shared-lane spawn — and defers every account's
// rotation, because over-deferring costs a delayed refresh while under-deferring revokes a
// single-use token out from under a running CLI (S9 §2e).
const lanePrincipalIdByPtyId = new Map<string, string>()
// Why: ids restored from persistence at startup, not yet confirmed against the
// daemon. They keep the OAuth refresh gate closed so an early managed refresh
// cannot rotate the single-use refresh token out from under a Claude CLI that
// survived the app restart inside the daemon.
const seededUnconfirmedPtyIds = new Set<string>()
let switchInProgress = false

export type ClaudeLivePtyPersistence = {
  addClaudeLivePtySessionId(sessionId: string): void
  removeClaudeLivePtySessionId(sessionId: string): void
}

let persistence: ClaudeLivePtyPersistence | null = null

export function attachClaudeLivePtyPersistence(target: ClaudeLivePtyPersistence | null): void {
  persistence = target
}

// Why: a live claude defers the managed OAuth refresh ("Waiting for Claude
// session"); consumers need the 1 -> 0 transition to recover promptly instead
// of waiting out the usage-fetch failure backoff.
type LiveClaudePtyDrainListener = () => void
const drainListeners = new Set<LiveClaudePtyDrainListener>()

export function onLiveClaudePtysDrained(listener: LiveClaudePtyDrainListener): () => void {
  drainListeners.add(listener)
  return () => drainListeners.delete(listener)
}

function notifyDrainedOnTransition(hadLivePtys: boolean): void {
  if (!hadLivePtys || liveClaudePtyIds.size > 0) {
    return
  }
  for (const listener of drainListeners) {
    listener()
  }
}

export function seedLiveClaudePtysFromPersistence(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    liveClaudePtyIds.add(sessionId)
    seededUnconfirmedPtyIds.add(sessionId)
  }
}

export function hasSeededUnconfirmedClaudePtys(): boolean {
  return seededUnconfirmedPtyIds.size > 0
}

/**
 * Reconcile seeded ids against the daemon's live session list. Seeded ids the
 * daemon no longer knows are dead — release them so they cannot defer OAuth
 * refresh forever. Seeded ids that are still alive stay in the gate even if
 * their pane never reattaches: that daemon process still owns the credentials.
 */
export function confirmSeededClaudeLivePtys(aliveSessionIds: readonly string[]): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  const alive = new Set(aliveSessionIds)
  for (const sessionId of seededUnconfirmedPtyIds) {
    if (!alive.has(sessionId)) {
      liveClaudePtyIds.delete(sessionId)
      lanePrincipalIdByPtyId.delete(sessionId)
      persistence?.removeClaudeLivePtySessionId(sessionId)
    }
  }
  seededUnconfirmedPtyIds.clear()
  notifyDrainedOnTransition(hadLivePtys)
}

export function markClaudePtySpawned(ptyId: string, lanePrincipalId?: string | null): void {
  liveClaudePtyIds.add(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  if (lanePrincipalId) {
    lanePrincipalIdByPtyId.set(ptyId, lanePrincipalId)
  }
  persistence?.addClaudeLivePtySessionId(ptyId)
}

export function markClaudePtyExited(ptyId: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  liveClaudePtyIds.delete(ptyId)
  lanePrincipalIdByPtyId.delete(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  persistence?.removeClaudeLivePtySessionId(ptyId)
  notifyDrainedOnTransition(hadLivePtys)
}

export function hasLiveClaudePtys(): boolean {
  return liveClaudePtyIds.size > 0
}

/** Whether a pty pinned to THIS lane is live — the query the lane's rotation gate asks. */
export function hasLiveClaudePtysInLane(lanePrincipalId: string): boolean {
  for (const [ptyId, laneId] of lanePrincipalIdByPtyId) {
    if (laneId === lanePrincipalId && liveClaudePtyIds.has(ptyId)) {
      return true
    }
  }
  return false
}

/** Live ptys this process cannot attribute to a lane; they defer every account's rotation. */
export function hasUnattributedLiveClaudePtys(): boolean {
  for (const ptyId of liveClaudePtyIds) {
    if (!lanePrincipalIdByPtyId.has(ptyId)) {
      return true
    }
  }
  return false
}

export function beginClaudeAuthSwitch(): void {
  if (switchInProgress) {
    throw new Error('A Claude account switch is already in progress.')
  }
  switchInProgress = true
}

export function endClaudeAuthSwitch(): void {
  switchInProgress = false
}

export function isClaudeAuthSwitchInProgress(): boolean {
  return switchInProgress
}
