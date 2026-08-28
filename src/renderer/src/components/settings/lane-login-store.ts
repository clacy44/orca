// S9-L2 (design rev 38 §2l/§3): the renderer endpoint of the lane-login IPC seam, one snapshot per
// paired environment (a login runs against a specific remote host, exactly as delegate/refresh do
// in `principal-lane-status-store.ts`). Kept as an external store for the same reason that one is.
import { useSyncExternalStore } from 'react'
import type { LaneLoginEnvironmentSnapshotDto } from '../../../../shared/lane-login-ipc'

// Cached per environmentId (not rebuilt per read): useSyncExternalStore compares snapshots by
// reference, and a getSnapshot that allocates a fresh object every call is an infinite update loop.
const emptySnapshots = new Map<string, LaneLoginEnvironmentSnapshotDto>()

function emptySnapshot(environmentId: string): LaneLoginEnvironmentSnapshotDto {
  let snapshot = emptySnapshots.get(environmentId)
  if (!snapshot) {
    snapshot = {
      environmentId,
      capability: 'unknown',
      accounts: [],
      activeLoginSessionId: null,
      activeLoginExpiresAt: null,
      lastLoginError: null
    }
    emptySnapshots.set(environmentId, snapshot)
  }
  return snapshot
}

const snapshots = new Map<string, LaneLoginEnvironmentSnapshotDto>()
const listeners = new Map<string, Set<() => void>>()

function notify(environmentId: string): void {
  for (const listener of listeners.get(environmentId) ?? []) {
    listener()
  }
}

export function setLaneLoginSnapshot(snapshot: LaneLoginEnvironmentSnapshotDto): void {
  snapshots.set(snapshot.environmentId, snapshot)
  notify(snapshot.environmentId)
}

export function getLaneLoginSnapshot(environmentId: string): LaneLoginEnvironmentSnapshotDto {
  return snapshots.get(environmentId) ?? emptySnapshot(environmentId)
}

function subscribe(environmentId: string, onChange: () => void): () => void {
  let set = listeners.get(environmentId)
  if (!set) {
    set = new Set()
    listeners.set(environmentId, set)
  }
  set.add(onChange)
  return () => set!.delete(onChange)
}

export function useLaneLogin(environmentId: string): LaneLoginEnvironmentSnapshotDto {
  return useSyncExternalStore(
    (onChange) => subscribe(environmentId, onChange),
    () => getLaneLoginSnapshot(environmentId),
    () => emptySnapshot(environmentId)
  )
}

/**
 * Wires the store to the preload lane for one environment: an initial `get` (which also connects/
 * probes the capability on the host), then `onChanged` republishes filtered to this environment.
 */
export function startLaneLoginSubscription(
  environmentId: string,
  api: {
    get: (environmentId: string) => Promise<LaneLoginEnvironmentSnapshotDto | null>
    onChanged: (callback: (snapshot: LaneLoginEnvironmentSnapshotDto) => void) => () => void
  }
): () => void {
  let active = true
  const stopOnChanged = api.onChanged((next) => {
    if (active && next.environmentId === environmentId) {
      setLaneLoginSnapshot(next)
    }
  })
  void api
    .get(environmentId)
    .then((initial) => {
      if (active && initial) {
        setLaneLoginSnapshot(initial)
      }
    })
    .catch(() => {
      // A missing/unreachable host answers nothing; the empty snapshot is the correct render state.
    })
  return () => {
    active = false
    stopOnChanged()
  }
}

/** Test-only: snapshots are module-global, so a seeded case would otherwise leak into the next. */
export function resetLaneLoginStoreForTest(): void {
  snapshots.clear()
  listeners.clear()
  emptySnapshots.clear()
}
