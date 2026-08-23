const liveClaudePtyIds = new Set<string>()

/**
 * The shared lane's reserved key, mirroring `terminal-presence-registry.ts`'s attachment key.
 *
 * A principal id is a v4 UUID, so nothing can collide with it (S9 §2f).
 */
export const SHARED_CLAUDE_LANE_KEY = 'host'

// Why: which credential lane each live pty was pinned to. A pty absent from this map is
// UNATTRIBUTED — seeded from persistence and not yet reconciled — and defers every account's
// rotation, because over-deferring costs a delayed refresh while under-deferring revokes a
// single-use token out from under a running CLI (S9 §2e). A SPAWN is never in that class: it is
// pinned to a lane or to the shared one, and L1 forbids a lane's account also being the shared
// one, so a shared-lane `claude` defers nobody's lane.
const lanePrincipalIdByPtyId = new Map<string, string>()
// Why: ids restored from persistence at startup, not yet confirmed against the
// daemon. They keep the OAuth refresh gate closed so an early managed refresh
// cannot rotate the single-use refresh token out from under a Claude CLI that
// survived the app restart inside the daemon.
const seededUnconfirmedPtyIds = new Set<string>()
/**
 * Gate members that must NOT be persisted (S9 §2k).
 *
 * The lane usage probe never reaches `provider.spawn`, so it has no id in the daemon's namespace
 * at all — it mints a synthetic, lane-scoped one. `markClaudePtySpawned` persists every id it is
 * handed, so a synthetic id would land in `claudeLivePtySessionIds`, be seeded back at the next
 * startup, and defer that account's rotation until the daemon reconciliation dropped it as
 * unknown. It self-heals, but only after the startup pass §2e had to make observe-only.
 */
const ephemeralPtyIds = new Set<string>()
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

/** The lane is required, not optional: an omitted one silently deferred every lane's rotation. */
export function markClaudePtySpawned(ptyId: string, lanePrincipalId: string | null): void {
  liveClaudePtyIds.add(ptyId)
  seededUnconfirmedPtyIds.delete(ptyId)
  lanePrincipalIdByPtyId.set(ptyId, lanePrincipalId || SHARED_CLAUDE_LANE_KEY)
  persistence?.addClaudeLivePtySessionId(ptyId)
}

/**
 * The lane usage probe's arm: same deferral, never persisted, never seeded back.
 *
 * A probe in lane L defers rotation of L's account exactly as a user's `claude` does — the probe
 * IS a live claude holding that lane's single-use refresh token.
 */
export function markEphemeralClaudePtySpawned(ptyId: string, lanePrincipalId: string): void {
  liveClaudePtyIds.add(ptyId)
  ephemeralPtyIds.add(ptyId)
  lanePrincipalIdByPtyId.set(ptyId, lanePrincipalId)
}

export function markEphemeralClaudePtyExited(ptyId: string): void {
  const hadLivePtys = liveClaudePtyIds.size > 0
  ephemeralPtyIds.delete(ptyId)
  liveClaudePtyIds.delete(ptyId)
  lanePrincipalIdByPtyId.delete(ptyId)
  notifyDrainedOnTransition(hadLivePtys)
}

/** Test seam: a synthetic id must never reach `persistence.addClaudeLivePtySessionId`. */
export function isEphemeralClaudePty(ptyId: string): boolean {
  return ephemeralPtyIds.has(ptyId)
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

/**
 * The PERSONAL lanes a live `claude` is running in, deduplicated (S9 §2c trigger 2, first arm).
 *
 * The shared lane is excluded by its reserved key: it has no lane file to sync, and its rotation
 * is `doSyncForCurrentSelection`'s business.
 */
export function listLanesWithLiveClaudePtys(): string[] {
  const laneIds = new Set<string>()
  for (const [ptyId, laneId] of lanePrincipalIdByPtyId) {
    if (laneId !== SHARED_CLAUDE_LANE_KEY && liveClaudePtyIds.has(ptyId)) {
      laneIds.add(laneId)
    }
  }
  return [...laneIds]
}

/** Seeded ids this process has not reconciled yet; they defer every account's rotation. */
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
