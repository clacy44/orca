// S10-16 C5, R18.4(a)/(b): the pre-dial bounded hold and the retarget — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Never touches consecutive_failures.
import type { OrcaRuntimeService } from '../orca-runtime'
import { localEvidenceUnavailable } from './link-binding-routable'
import type { ReplyOutboxRow } from './reply-outbox-store'
import {
  fireReplyRelayDispositionNotice,
  auditReplyRelaySettleRaced
} from './reply-outbox-pump-notify'
import {
  REPLY_OUTBOX_HOLD_INTERVAL_MS,
  REPLY_OUTBOX_HOLD_MAX_MS,
  REPLY_RELAY_ROUTE_MOVED_NOTICE,
  ROUTE_MOVED_CODE,
  BINDING_CHANGED_CODE
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
  const retargeted = db.findRoutableBindingByKeyFingerprint(item.peerKeyFingerprint)
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
  // resolved to the row's CURRENT route) NEVER settles at this deadline — not route_moved (the
  // route did not move) and not the binding_changed/reply_relay_refused pairing the C5d review
  // found dishonest (a peer refusal that never happened). Only the genuine "no routable binding
  // found at all" case (retargeted === null, !isSameRoute) settles here, with route_moved. A
  // same-route item falls through to the bounded hold below and keeps being re-checked;
  // R18.3's REPLY_OUTBOX_MAX_AGE_MS deadline (processItem, evaluated on every claim) is the ONLY
  // thing that can eventually settle it — abandoned, with reply_relay_abandoned — exactly the
  // shape R18.4(a) already prescribes for the local-evidence hold.
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
  // Ruling 26 Addendum 3(dd)/F4: the boolean is checked — a lost hold (row cancelled underneath
  // this call) is audited, never silently dropped.
  const heldBindingChanged = db.holdReplyOutboxItem(
    item.id,
    now,
    now + REPLY_OUTBOX_HOLD_INTERVAL_MS,
    BINDING_CHANGED_CODE
  )
  if (!heldBindingChanged) {
    auditReplyRelaySettleRaced(db, item, 'hold')
  }
}
