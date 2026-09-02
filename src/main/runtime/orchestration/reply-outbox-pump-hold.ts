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
    db.retargetReplyOutboxItem(item.id, {
      linkDeviceId: retargeted.linkDeviceId,
      environmentId: retargeted.environmentId,
      boundPairingRevision: retargeted.boundPairingRevision,
      peerCredentialFp: retargeted.peerCredentialFp,
      peerKeyFingerprint: retargeted.peerKeyFingerprint
    })
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: retargeted.linkDeviceId,
      verb: 'replyRelayRetarget',
      outcome: `from:${item.linkDeviceId} to:${retargeted.linkDeviceId}`,
      reasonCode: null
    })
    // The claim is already released ('sending' -> nothing) implicitly: retarget runs on a row
    // still in 'sending' state, so return it to 'queued' first via the same hold path's shape.
    db.holdReplyOutboxItem(item.id, now, now, BINDING_CHANGED_CODE)
    return
  }
  db.holdReplyOutboxItem(item.id, now, now + REPLY_OUTBOX_HOLD_INTERVAL_MS, BINDING_CHANGED_CODE)
  const firstHeldAt = db.getReplyOutboxItem(item.id)?.firstHeldAt ?? now
  if (now - firstHeldAt > REPLY_OUTBOX_HOLD_MAX_MS) {
    db.settleReplyOutboxItem(item.id, {
      state: 'refused',
      settledAt: now,
      consecutiveFailures: item.consecutiveFailures,
      nextAttemptAfter: null,
      lastErrorCode: ROUTE_MOVED_CODE,
      lastError: null
    })
    fireReplyRelayNotice(runtime, item, REPLY_RELAY_ROUTE_MOVED_NOTICE, null)
  }
}
