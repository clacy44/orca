// Why ref-counting over the shipped single-owner start (S9 §10(d)): the desktop's own lane status
// feeds TWO host-only surfaces at once — the consent surface's provisioning state and the
// AccountsPane lane section's leases — so if each called `startPrincipalLaneStatusSubscription`
// directly, the first to unmount would reset the shared module store out from under the other. This
// acquires ONE live subscription for the whole renderer and only tears it down when the last holder
// releases, so a section mounting or unmounting never blanks its sibling.
import { startPrincipalLaneStatusSubscription } from './principal-lane-status-store'

let holders = 0
let stop: (() => void) | null = null

export function acquirePrincipalLaneStatusSubscription(): () => void {
  holders += 1
  if (holders === 1) {
    stop = startPrincipalLaneStatusSubscription(window.api.principalLaneStatus)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    holders -= 1
    if (holders === 0 && stop) {
      stop()
      stop = null
    }
  }
}

/** Test-only: the ref count is module-global, so a leaked holder would otherwise carry over. */
export function resetPrincipalLaneStatusSubscriptionForTest(): void {
  holders = 0
  stop = null
}
