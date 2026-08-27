// The renderer endpoint of the host-only lane-status seam (S9 §2e/§2h, §10(d)). The AccountsPane
// section reads THIS desktop's own principal-lane residency and its delegation leases from here;
// the store is fed by the preload `principalLaneStatus` lane — a `get` on mount, then `onChanged`
// republishes. Kept out of Zustand for the same reason presence is: it is a small, self-contained
// external store a section subscribes to, not app-wide state.
import { useSyncExternalStore } from 'react'
import type {
  PrincipalLaneStatusSnapshot,
  PrincipalLaneStatusRow
} from '../../../../shared/principal-lane-status-ipc'

const EMPTY_SNAPSHOT: PrincipalLaneStatusSnapshot = Object.freeze({
  lanes: [],
  delegationLeases: [],
  delegableHosts: [],
  remoteHosts: []
}) as PrincipalLaneStatusSnapshot

let snapshot: PrincipalLaneStatusSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setPrincipalLaneStatusSnapshot(next: PrincipalLaneStatusSnapshot): void {
  snapshot = next
  notify()
}

export function getPrincipalLaneStatusSnapshot(): PrincipalLaneStatusSnapshot {
  return snapshot
}

/** All delegation leases this desktop holds, or none — the AccountsPane lease view's input (§2e). */
export function getDelegationLeases(): PrincipalLaneStatusSnapshot['delegationLeases'] {
  return snapshot.delegationLeases
}

/** One provisioned lane's status, or null when this desktop provisioned no such lane (§2h). */
export function getPrincipalLaneStatus(principalId: string): PrincipalLaneStatusRow | null {
  return snapshot.lanes.find((lane) => lane.principalId === principalId) ?? null
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function usePrincipalLaneStatus(): PrincipalLaneStatusSnapshot {
  return useSyncExternalStore(subscribe, getPrincipalLaneStatusSnapshot, () => EMPTY_SNAPSHOT)
}

/**
 * Wire the store to the preload lane: read the current snapshot, then keep it fresh through the
 * host's republish (provision/deprovision/residency change). Returns an unsubscribe that also drops
 * the store back to empty, so a remount re-hydrates rather than inheriting a stale snapshot.
 */
export function startPrincipalLaneStatusSubscription(api: {
  get: () => Promise<PrincipalLaneStatusSnapshot>
  onChanged: (callback: (snapshot: PrincipalLaneStatusSnapshot) => void) => () => void
}): () => void {
  let active = true
  const stopOnChanged = api.onChanged((next) => {
    if (active) {
      setPrincipalLaneStatusSnapshot(next)
    }
  })
  void api
    .get()
    .then((initial) => {
      // Why guarded: a republish can land before the initial read resolves, and that push is newer.
      if (active && snapshot === EMPTY_SNAPSHOT) {
        setPrincipalLaneStatusSnapshot(initial)
      }
    })
    .catch(() => {
      // A missing lane host answers nothing; the empty snapshot is the correct AccountsPane state.
    })
  return () => {
    active = false
    stopOnChanged()
    setPrincipalLaneStatusSnapshot(EMPTY_SNAPSHOT)
  }
}

/** Test-only: the snapshot is module-global, so a seeded case would otherwise leak into the next. */
export function resetPrincipalLaneStatusStoreForTest(): void {
  snapshot = EMPTY_SNAPSHOT
  listeners.clear()
}
