// [S10-21f b4, R147] Pure accounting for a withheld pointer-delivery record that survives
// repeated withholds instead of being overwritten each time. orca-runtime.ts owns the map this
// record lives in and every side effect (console.warn, the slow-retry timer); this module only
// computes the next record and the two booleans that decide what orca-runtime.ts should do with
// it. Kept pure and file-local (no orca-runtime.ts import) so it can be unit-tested without the
// runtime's fake-timer/mock-db harness — orca-runtime.ts is on the max-lines ratchet allowlist,
// so the logic below lives here rather than growing that file.

/** One withheld-delivery record. `firstAt` is stamped once and never touched again by
 *  `recordWithheld` — it is the only field that answers "how long has this mailbox been
 *  starved", independent of how many times a retry has re-withheld it since. */
export type DeliveryStarvationRecord = {
  readonly firstAt: number
  readonly at: number
  readonly count: number
  readonly reason: string
}

/** Compute the next record for a withhold at `now`. `prev` is the record already on file for
 *  this mailbox, or undefined for a first-ever withhold. `firstAt` carries forward from `prev`
 *  unchanged; `at`/`count`/`reason` always reflect this latest withhold. */
export function recordWithheld(
  prev: DeliveryStarvationRecord | undefined,
  reason: string,
  now: number
): DeliveryStarvationRecord {
  return {
    firstAt: prev?.firstAt ?? now,
    at: now,
    count: (prev?.count ?? 0) + 1,
    reason
  }
}

/** Whether this record has been withheld for at least `boundMs` since its first withhold. */
export function hasCrossedBound(
  record: DeliveryStarvationRecord,
  now: number,
  boundMs: number
): boolean {
  return now - record.firstAt >= boundMs
}

/** Whether orca-runtime.ts should console.warn for this withhold: only the very first withhold
 *  of a fresh record (count === 1, nothing logged for it yet) or the transition into having
 *  crossed the starvation bound — never every retry in between, which would spam the log every
 *  ~5 minutes for a long-withheld mailbox. `crossed` is the caller's own `hasCrossedBound`
 *  result for this same record/now, passed in rather than recomputed so the two never disagree
 *  about `now`. */
export function shouldLog(record: DeliveryStarvationRecord, crossed: boolean): boolean {
  return record.count === 1 || crossed
}
