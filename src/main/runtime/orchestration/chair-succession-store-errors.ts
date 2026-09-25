// S10-22a G1 repair round: split out of chair-succession-store.ts (line ratchet) — the store's
// two typed error classes.
import type { SuccessionState } from './chair-succession-types'

export class SuccessionBadTransitionError extends Error {
  readonly code = 'succession_bad_transition' as const
  constructor(from: SuccessionState, to: SuccessionState) {
    super(`succession_bad_transition: ${from} -> ${to} is not a legal transition`)
    this.name = 'SuccessionBadTransitionError'
  }
}

/** G1 repair M2: thrown by `createSealed`'s in-lock re-check (not just `sealSuccession`'s outer,
 * unlocked `listActive` read) so two concurrent `succeed` calls for the same chair can never both
 * win — the second one always sees the first's directory once it has the lock. */
export class SuccessionInFlightError extends Error {
  readonly code = 'succession_in_flight' as const
  readonly successionId: string
  readonly state: SuccessionState
  constructor(successionId: string, state: SuccessionState) {
    super(`succession_in_flight: ${successionId} is ${state}`)
    this.name = 'SuccessionInFlightError'
    this.successionId = successionId
    this.state = state
  }
}
