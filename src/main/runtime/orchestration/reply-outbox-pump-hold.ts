// S10-16 C5, R18.4(a)/(b): the pre-dial bounded hold and the retarget — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet. Never touches consecutive_failures.
import type { OrcaRuntimeService } from '../orca-runtime'
import { localEvidenceUnavailable } from './link-binding-routable'
import type { ReplyOutboxRow } from './reply-outbox-store'
import { fireReplyRelayNotice } from './reply-outbox-pump-notify'
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
    db.holdReplyOutboxItemLocalEvidence(item.id, now, now + REPLY_OUTBOX_HOLD_INTERVAL_MS)
    return
  }
  const retargeted = db.findRoutableBindingByKeyFingerprint(item.peerKeyFingerprint)
  if (retargeted) {
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
  if (now - firstHeldAt > REPLY_OUTBOX_HOLD_MAX_MS) {
    const settled = db.settleReplyOutboxItem(item.id, {
      state: 'refused',
      settledAt: now,
      consecutiveFailures: item.consecutiveFailures,
      nextAttemptAfter: null,
      lastErrorCode: ROUTE_MOVED_CODE,
      lastError: null
    })
    if (settled) {
      fireReplyRelayNotice(runtime, item, REPLY_RELAY_ROUTE_MOVED_NOTICE, null)
    } else {
      db.writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'replyRelay',
        outcome: 'settle_raced',
        reasonCode: JSON.stringify({ outboxId: item.id, cause: 'route_moved' })
      })
    }
    return
  }
  db.holdReplyOutboxItem(item.id, now, now + REPLY_OUTBOX_HOLD_INTERVAL_MS, BINDING_CHANGED_CODE)
}
