// S10-16 C4c, R13 trigger table/R13.4 (design v6) + Ruling 23 Addendum 4(hh): the sweep's own
// maintenance checks — split out of link-binding-prover.ts (Ruling 23(m): a split is the only
// remedy for the 300-line gate, no baseline entry) — `createLinkBindingProver`'s arm()/tick() is
// the only caller.
//
// Two checks: (1) an environment-set digest (`listEnvironments()`'s `id:pairingRevision` pairs) —
// a change re-arms every parked link and invalidates the capability cache (R13's third re-arm
// condition; the first-inbound-contact and register-timer re-arms live in `scheduleBinding` and
// link-binding-prover-round.ts respectively). (2) R13.4's sweep-owned deletion
// (`deleteBindingsAndAttemptsNotIn`), guarded on the registry having actually loaded and being
// non-empty — wired here (review C4b finding 14) rather than left an implemented, unit-tested,
// uncalled control.
import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { LINK_BINDING_REVERIFY_MS } from './orchestration/link-binding-constants'
import { resolveUserDataPath } from './rpc/methods/orchestration-link-binding-pending'
import type { CapabilityCache } from './link-binding-prover-round'
import type { RearmDebounce } from './orchestration/link-binding-schedule'

export type MaintenanceTick = (now: number) => void

export function createMaintenanceTick(
  runtime: OrcaRuntimeService,
  capabilityCache: CapabilityCache,
  // Ruling 23 Addendum 6(ww)/review C4d finding 10: the SAME debounce map `scheduleBinding` and
  // the round.ts register-timer fallback use — this digest re-arm records into it too, so a
  // subsequent inbound-contact re-arm sees this one happened.
  rearmDebounce: RearmDebounce
): MaintenanceTick {
  // `null` until the first observation — no baseline to compare against yet, so the first tick
  // never fires a spurious re-arm.
  let lastEnvironmentDigest: string | null = null
  // R13.4: runs at startup (0 means "never yet") and every LINK_BINDING_REVERIFY_MS thereafter.
  let lastPurgeAt = 0

  function rearmParkedLinksAndInvalidateCapabilities(now: number): void {
    capabilityCache.clear()
    const selfView = runtime.linkBindingSelfView
    if (!selfView) {
      return
    }
    const db = runtime.getOrchestrationDb()
    for (const link of selfView.listRuntimeLinkCandidates()) {
      const attempt = db.getBindingAttempt(link.deviceId)
      if (attempt?.lastOutcome !== 'unpaired_parked') {
        continue
      }
      db.settleBindingAttempt(link.deviceId, {
        lastAttemptAt: attempt.lastAttemptAt ?? now,
        lastRoundAt: attempt.lastRoundAt ?? now,
        lastOutcome: 'pending',
        lastDetail: attempt.lastDetail ?? null,
        consecutiveFailures: attempt.consecutiveFailures ?? 0,
        consecutiveNoWinner: 0,
        nextAttemptAfter: attempt.nextAttemptAfter ?? null
      })
      rearmDebounce.record(link.deviceId, now)
    }
  }

  function checkEnvironmentDigest(now: number): void {
    let digest: string | null
    try {
      const environments = listEnvironments(resolveUserDataPath())
      const parts = environments.map((e) => `${e.id}:${e.pairingRevision ?? e.createdAt}`).sort()
      digest = createHash('sha256').update(parts.join(',')).digest('hex')
    } catch {
      // F6/Ruling 23(v)'s principle extended: a read FAULT is never evidence of a change.
      return
    }
    if (lastEnvironmentDigest !== null && digest !== lastEnvironmentDigest) {
      rearmParkedLinksAndInvalidateCapabilities(now)
    }
    lastEnvironmentDigest = digest
  }

  function maybePurgeStaleLinks(now: number): void {
    const selfView = runtime.linkBindingSelfView
    if (!selfView || !selfView.registryLoadSucceeded()) {
      return
    }
    // Ruling 23 Addendum 5(pp)/review C4c finding 13: R13.4's own wording — "live runtime-scope
    // device ids" — not `listRuntimeLinkCandidates()`'s narrower "authenticated" set (which
    // additionally requires `lastSeenAt !== 0`, R10-A's own probing filter, not R13.4's retention
    // one).
    const retainedLinkDeviceIds = selfView.listRuntimeScopeDeviceIds()
    if (retainedLinkDeviceIds.length === 0) {
      return
    }
    if (lastPurgeAt !== 0 && now - lastPurgeAt < LINK_BINDING_REVERIFY_MS) {
      return
    }
    lastPurgeAt = now
    runtime.getOrchestrationDb().deleteBindingsAndAttemptsNotIn(retainedLinkDeviceIds)
  }

  // Both checks above are plain synchronous DB reads/writes, unlike `attemptRound`'s own async
  // body (whose synchronous `getOrchestrationDb()` throw is caught by its `.catch()`, since it
  // runs inside an `async function`) — a bare `setTimeout` callback has no such catch, so a
  // maintenance tick firing after shutdown/test teardown (the DB closed) would otherwise escape
  // as an unhandled exception. Best-effort only, matching F17's shutdown-guard precedent.
  return function runMaintenanceTick(now: number): void {
    try {
      checkEnvironmentDigest(now)
    } catch {
      // best-effort — see above.
    }
    try {
      maybePurgeStaleLinks(now)
    } catch {
      // best-effort — see above.
    }
  }
}
