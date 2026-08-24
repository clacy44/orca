// The renderer endpoint of the host-only consent seam (S9 §2a, §10(d) Part 4). The consent surface
// on the paired-device list reads the principal registry — principals, bindings and the audit trail —
// from here; the store is fed by the preload `principalConsent` lane: a `snapshot` on mount, then
// `onChanged` republishes after every write. Kept out of Zustand for the same reason the lane-status
// store is: a small, self-contained external store one host-only section subscribes to, not app-wide
// state. A non-host frame is sender-refused in main and reads the frozen empty snapshot forever.
import { useSyncExternalStore } from 'react'
import type { PrincipalConsentSnapshot } from '../../../../shared/principal-consent-ipc'

const EMPTY_SNAPSHOT: PrincipalConsentSnapshot = Object.freeze({
  principals: [],
  bindings: [],
  audit: []
}) as PrincipalConsentSnapshot

let snapshot: PrincipalConsentSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function setPrincipalConsentSnapshot(next: PrincipalConsentSnapshot): void {
  snapshot = next
  notify()
}

export function getPrincipalConsentSnapshot(): PrincipalConsentSnapshot {
  return snapshot
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function usePrincipalConsentSnapshot(): PrincipalConsentSnapshot {
  return useSyncExternalStore(subscribe, getPrincipalConsentSnapshot, () => EMPTY_SNAPSHOT)
}

/**
 * Wire the store to the preload lane: read the current snapshot, then keep it fresh through the
 * host's republish (every write republishes). Returns an unsubscribe that drops the store back to
 * empty, so a remount re-hydrates rather than inheriting a stale registry.
 */
export function startPrincipalConsentSubscription(api: {
  snapshot: () => Promise<PrincipalConsentSnapshot>
  onChanged: (callback: (snapshot: PrincipalConsentSnapshot) => void) => () => void
}): () => void {
  let active = true
  const stopOnChanged = api.onChanged((next) => {
    if (active) {
      setPrincipalConsentSnapshot(next)
    }
  })
  void api
    .snapshot()
    .then((initial) => {
      // Why guarded: a republish can land before the initial read resolves, and that push is newer.
      if (active && snapshot === EMPTY_SNAPSHOT) {
        setPrincipalConsentSnapshot(initial)
      }
    })
    .catch(() => {
      // A non-host frame (or a lane the host does not answer) leaves the empty snapshot, which is the
      // correct "no consent surface" state.
    })
  return () => {
    active = false
    stopOnChanged()
    setPrincipalConsentSnapshot(EMPTY_SNAPSHOT)
  }
}

/** Test-only: the snapshot is module-global, so a seeded case would otherwise leak into the next. */
export function resetPrincipalConsentStoreForTest(): void {
  snapshot = EMPTY_SNAPSHOT
  listeners.clear()
}
