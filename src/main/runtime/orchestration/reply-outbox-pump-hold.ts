// S10-16 C5, R18.4(a)/(b): the pre-dial bounded hold and the retarget — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Never touches consecutive_failures.
import type { OrcaRuntimeService } from '../orca-runtime'
import { localEvidenceUnavailable, getRoutableLinkBinding } from './link-binding-routable'
import type { ReplyOutboxRow } from './reply-outbox-store'
import {
  fireReplyRelayDispositionNotice,
  auditReplyRelaySettleRaced
} from './reply-outbox-pump-notify'
import {
  REPLY_OUTBOX_HOLD_INTERVAL_MS,
  REPLY_OUTBOX_HOLD_MAX_MS,
  REPLY_RELAY_ROUTE_MOVED_NOTICE,
  REPLY_RELAY_ABANDONED_NOTICE,
  ROUTE_MOVED_CODE,
  BINDING_CHANGED_CODE,
  RUNTIME_ENVIRONMENT_CHANGED_CODE
} from './link-binding-constants'

// B1/B2/Ruling 26(b)/(c): a hold is expressed by next_attempt_after alone; a retarget is one
// statement that re-points AND releases the row (never followed by a hold write — that is what
// made the retargeted item dead-on-arrival, B1 consequence 2); and the route_moved deadline is
// read from the row already in hand, BEFORE any hold write, so it is evaluated against the
// item's real first-held time instead of a value the immediately preceding hold just set to
// `now` (B2 — which also made the branch structurally unreachable).
export function holdOrRetargetReplyOutboxItem(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  now: number
): void {
  const db = runtime.getOrchestrationDb()
  if (localEvidenceUnavailable(runtime)) {
    const heldLocalEvidence = db.holdReplyOutboxItemLocalEvidence(
      item.id,
      now,
      now + REPLY_OUTBOX_HOLD_INTERVAL_MS
    )
    if (!heldLocalEvidence) {
      auditReplyRelaySettleRaced(db, item, 'hold_local_evidence')
    }
    return
  }
  // Ruling 26 Addendum 5(nn)/F2, Addendum 6(ss): the SQL candidate applies only two of R15's
  // clauses (state, revoked_at) — filtered here through the full routable predicate so a
  // retarget can never re-point onto a quarantined, pin-mismatched, or legacy_unattested link.
  // A candidate that fails the predicate is treated exactly like "no candidate" (falls through
  // to the hold below). `retargeted` is the freshly-read ROUTABLE row itself, not the earlier
  // candidate read — a binding rewritten between the two reads must not leave the retarget
  // writing stale candidate values while the routability decision was made on the fresh ones.
  const candidate = db.findBindingCandidateByKeyFingerprint(item.peerKeyFingerprint)
  const retargeted = candidate ? getRoutableLinkBinding(db, runtime, candidate.linkDeviceId) : null
  // Ruling 26 Addendum 1(n)/F1: a re-check that resolves to the row's CURRENT route is not a
  // retarget — retargeting it onto itself and releasing with next_attempt_after = NULL turns
  // every `runtime_environment_changed` re-check into an unbounded, unclamped dial loop (the
  // route still matches, so this always fired). Retarget only when the resolved route actually
  // differs; otherwise fall through to the bounded hold below, which starts first_held_at and
  // therefore the REPLY_OUTBOX_HOLD_MAX_MS/route_moved bound.
  // Ruling 26 Addendum 3(ee)/F5: peerCredentialFp is compared too — a credential-only rotation
  // (no pairing-revision bump) must not read as "same route" and keep a stale peer_credential_fp.
  const isSameRoute =
    retargeted !== null &&
    retargeted.linkDeviceId === item.linkDeviceId &&
    retargeted.environmentId === item.environmentId &&
    retargeted.boundPairingRevision === item.boundPairingRevision &&
    retargeted.peerCredentialFp === item.peerCredentialFp
  if (retargeted && !isSameRoute) {
    const retargetedRow = db.retargetReplyOutboxItem(item.id, {
      linkDeviceId: retargeted.linkDeviceId,
      environmentId: retargeted.environmentId,
      boundPairingRevision: retargeted.boundPairingRevision,
      peerCredentialFp: retargeted.peerCredentialFp,
      peerKeyFingerprint: retargeted.peerKeyFingerprint
    })
    if (!retargetedRow) {
      // R18.1: zero rows updated means the item was cancelled underneath this call — audit and
      // move on, never resurrect it.
      db.writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'replyRelayRetarget',
        outcome: 'settle_raced',
        reasonCode: JSON.stringify({ outboxId: item.id })
      })
      return
    }
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: retargeted.linkDeviceId,
      verb: 'replyRelayRetarget',
      outcome: `from:${item.linkDeviceId} to:${retargeted.linkDeviceId}`,
      reasonCode: null
    })
    return
  }
  // Ruling 26(c): evaluated from item.firstHeldAt as already read at claim time — BEFORE the
  // hold write below (which is the only statement in this function that could advance it).
  const firstHeldAt = item.firstHeldAt ?? now
  // Ruling 26 Addendum 4(kk): a same-route hold (isSameRoute true — this tick's own re-check
  // resolved to the row's CURRENT route) NEVER settles route_moved (the route did not move) nor
  // the binding_changed/reply_relay_refused pairing the C5d review found dishonest (a peer
  // refusal that never happened). Only the genuine "no routable binding found at all" case
  // (retargeted === null, !isSameRoute) settles here, with route_moved.
  if (!isSameRoute && now - firstHeldAt > REPLY_OUTBOX_HOLD_MAX_MS) {
    const settled = db.settleReplyOutboxItem(item.id, {
      state: 'refused',
      settledAt: now,
      consecutiveFailures: item.consecutiveFailures,
      nextAttemptAfter: null,
      lastErrorCode: ROUTE_MOVED_CODE,
      lastError: null
    })
    if (settled) {
      // Ruling 26 Addendum 4(hh): route_moved is a disposition-family notice.
      fireReplyRelayDispositionNotice(runtime, item, REPLY_RELAY_ROUTE_MOVED_NOTICE, null)
    } else {
      auditReplyRelaySettleRaced(db, item, 'route_moved')
    }
    return
  }
  // Ruling 26 Addendum 5(mm): the same-route hold is bounded by REPLY_OUTBOX_HOLD_MAX_MS too —
  // not the 7-day REPLY_OUTBOX_MAX_AGE_MS deadline C5e left it to. At the same deadline
  // route_moved uses, a same-route item settles abandoned with the existing
  // reply_relay_abandoned code and notice — an honest word (the route never moved, and no
  // refusal happened) reached inside the R19.3 detection window instead of seven days later.
  if (isSameRoute && now - firstHeldAt > REPLY_OUTBOX_HOLD_MAX_MS) {
    const settled = db.settleReplyOutboxItem(item.id, {
      state: 'abandoned',
      settledAt: now,
      consecutiveFailures: item.consecutiveFailures,
      nextAttemptAfter: null,
      lastErrorCode: item.lastErrorCode,
      lastError: item.lastError
    })
    if (settled) {
      fireReplyRelayDispositionNotice(runtime, item, REPLY_RELAY_ABANDONED_NOTICE, null)
    } else {
      auditReplyRelaySettleRaced(db, item, 'abandoned')
    }
    return
  }
  // Ruling 26 Addendum 3(dd)/F4: the boolean is checked — a lost hold (row cancelled underneath
  // this call) is audited, never silently dropped.
  // Ruling 26 Addendum 5(mm): while held, last_error_code carries the disposition the peer
  // actually returned (runtime_environment_changed) for a same-route hold — never
  // BINDING_CHANGED_CODE, which is false when the route has not changed. The no-route-found case
  // (!isSameRoute, still within the window) keeps BINDING_CHANGED_CODE; it is genuinely a
  // binding change from this row's point of view. Neither path bumps consecutive_failures — a
  // peer-chosen disposition is never evidence the transport is unreachable.
  const heldRow = db.holdReplyOutboxItem(
    item.id,
    now,
    now + REPLY_OUTBOX_HOLD_INTERVAL_MS,
    isSameRoute ? RUNTIME_ENVIRONMENT_CHANGED_CODE : BINDING_CHANGED_CODE
  )
  if (!heldRow) {
    auditReplyRelaySettleRaced(db, item, 'hold')
  }
}
