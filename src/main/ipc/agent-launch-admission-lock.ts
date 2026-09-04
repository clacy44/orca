// S10-21a C3-v2 (errata 5(p) v2.1 §C.1 F-H2): the (hostId, paneKey) admission lock. Split out of
// agent-launch-admission.ts to stay under the repo's max-lines budget.
import { LaunchAdmissionRefusedError } from './agent-launch-admission-errors'

// In-process async mutex keyed `${hostId}\0${paneKey}`, held from the ownership read through
// confirm/compensate. Chained-promise queue: each waiter registers its own slot before awaiting
// the prior one, so N waiters serialise in arrival order. A waiter that times out at 30s still
// resolves its own slot (harmless: downstream waiters depend on the PRIOR slot, not this one) and
// never removes another holder's map entry.
export const PANE_LOCK_TIMEOUT_MS = 30_000
const paneLockTails = new Map<string, Promise<void>>()
const LOCK_TIMEOUT = Symbol('launch-admission-lock-timeout')

export async function withPaneLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = paneLockTails.get(key) ?? Promise.resolve()
  let releaseThis!: () => void
  const thisSlot = new Promise<void>((resolve) => {
    releaseThis = resolve
  })
  const chained = prior.then(() => thisSlot)
  paneLockTails.set(key, chained)
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<typeof LOCK_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(LOCK_TIMEOUT), PANE_LOCK_TIMEOUT_MS)
  })
  const raced = await Promise.race([prior.then((): 'acquired' => 'acquired'), timeout])
  clearTimeout(timer!)
  if (raced === LOCK_TIMEOUT) {
    releaseThis()
    // [D-R104 F-11 fix] The `finally` below never runs on this path (it throws before the
    // `try`) — without this, `paneLockTails` keeps this (already-resolved) `chained` entry
    // forever once this is the newest waiter for `key`.
    if (paneLockTails.get(key) === chained) {
      paneLockTails.delete(key)
    }
    throw new LaunchAdmissionRefusedError('launch_admission_timeout')
  }
  try {
    return await fn()
  } finally {
    releaseThis()
    if (paneLockTails.get(key) === chained) {
      paneLockTails.delete(key)
    }
  }
}
