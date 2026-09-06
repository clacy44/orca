// S10-21b B5 (design §2.9, closes Addendum 6(15)/NA8): the metered-audit half of pact relay's
// audit suppression — at most one audit row per (link, pact_thread, code) per
// LINK_BINDING_RATE_WINDOW_MS (60s), reusing the house `checkAndBumpRate` pattern
// (orchestration-link-binding-pending.ts:121-126). The disposition itself (retry/hold/terminal
// settle) is decided and always fires elsewhere — this only meters the audit row + notice; the
// caller writes the row itself when this returns true. No I/O beyond the meter bump.
import type { OrchestrationDb } from './db'
import { LINK_BINDING_RATE_WINDOW_MS } from './link-binding-constants'

export function shouldEmitPactRelayAudit(
  db: OrchestrationDb,
  linkDeviceId: string,
  pactThreadId: string,
  code: string
): boolean {
  const gate = db.checkAndBumpRate({
    subjectKey: `pactRelay:${linkDeviceId}:${pactThreadId}`,
    verb: `pactRelayAudit:${code}`,
    windowMs: LINK_BINDING_RATE_WINDOW_MS,
    limit: 1
  })
  return gate.allowed
}

// S10-21b B5 (design §2.9, [v3.1, Addendum 6(15)]/NA8): `pact_desync`'s audit/notice is metered
// exactly like the codes above, but its DISPOSITION (pause + tail-cancel + repair-counter
// bookkeeping, §2.6(c)) is commit 9's job and is NEVER suppressed by this check — commit 9 calls
// this BEFORE firing that disposition, to decide only whether THIS occurrence also gets its own
// audit row + `pact_relay_failed` notice, or folds into the window's existing one.
export function shouldEmitPactDesyncAudit(
  db: OrchestrationDb,
  linkDeviceId: string,
  pactThreadId: string
): boolean {
  return shouldEmitPactRelayAudit(db, linkDeviceId, pactThreadId, 'pact_desync')
}
