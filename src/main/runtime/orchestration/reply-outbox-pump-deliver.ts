// S10-16 C5, H4/H6 (Ruling 26(e)/(g)): the successful-dial half of the pump's per-item work —
// validating the peer's federatedSend receipt against the host id grammar, the delivered settle,
// and the post-delivery bookkeeping (kept in its OWN try, outside the send try) — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet.
import type { OrcaRuntimeService } from '../orca-runtime'
import { isHostMessageId, requireOptionalThreadId } from './orchestration-id-grammar'
import { shouldFireReplyRelayNotice } from './reply-outbox-health'
import type { ReplyOutboxRow } from './reply-outbox-store'
import { fireReplyRelayNotice, onReplyOutboxDelivered } from './reply-outbox-pump-notify'
import {
  PEER_RESULT_MALFORMED_CODE,
  REPLY_RELAY_BOOKKEEPING_FAILED_CODE,
  REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE
} from './link-binding-constants'

export type FederatedSendResultShape = {
  accepted: true
  messageId: string
  threadId: string | null
  authorshipUnconfirmed?: boolean
}

// H4/Ruling 26(e) + H6/Ruling 26(g), as one function: validate the peer's receipt, settle
// `delivered`, then run post-delivery bookkeeping in its OWN try (a throw there is a local
// bookkeeping fault, audited — never a transport failure, never a retry of a delivered row).
export function settleReplyOutboxDelivery(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  result: FederatedSendResultShape
): void {
  const db = runtime.getOrchestrationDb()

  // H4/Ruling 26(e): the peer's federatedSend result is untrusted. A malformed id is NOT a
  // transport failure — the peer already accepted the reply; retrying would double-deliver —
  // so the row still settles `delivered`, with the offending id(s) NULL, plus one audit row
  // carrying the host-constant code. No peer byte is echoed into a store untyped.
  const validMessageId = isHostMessageId(result.messageId) ? result.messageId : null
  let validThreadId: string | null = null
  let malformed = validMessageId === null
  try {
    validThreadId = requireOptionalThreadId(result.threadId, 'peer federatedSend threadId')
  } catch {
    malformed = true
  }
  if (malformed) {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: item.linkDeviceId,
      verb: 'replyRelay',
      outcome: PEER_RESULT_MALFORMED_CODE,
      reasonCode: JSON.stringify({ outboxId: item.id })
    })
  }
  db.markPeerRelayAccepted(item.localMessageId, validThreadId)
  db.settleReplyOutboxItem(item.id, {
    state: 'delivered',
    settledAt: Date.now(),
    consecutiveFailures: 0,
    nextAttemptAfter: null,
    lastErrorCode: null,
    lastError: null,
    peerMessageId: validMessageId,
    peerReplyThreadId: validThreadId
  })

  // H6/Ruling 26(g): post-delivery bookkeeping, OUTSIDE the send try. A throw here is audited
  // with a host-constant code — never classified as a transport failure, never a retry of an
  // already-delivered row.
  try {
    onReplyOutboxDelivered(runtime, item)
    if (result.authorshipUnconfirmed !== true) {
      // R20.2 (v6, protocol M2/lifecycle M1): a clean delivery clears the advisory state.
      db.clearLinkAdvisory(item.linkDeviceId)
    } else {
      db.bumpMisrouteAdvisories(item.linkDeviceId)
      db.putLinkAdvisory(
        item.linkDeviceId,
        { kind: 'authorship_unconfirmed', outboxId: item.id, environmentId: item.environmentId },
        Date.now()
      )
      db.writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: item.linkDeviceId,
        verb: 'replyRelay',
        outcome: 'authorship_unconfirmed',
        reasonCode: null
      })
      if (
        shouldFireReplyRelayNotice(
          item,
          db.replyOutboxLinkLastAdvisoryNotifiedAt(item.linkDeviceId),
          Date.now()
        )
      ) {
        // Ruling 26 Addendum 6(rr): stamp AFTER the send succeeds — same rule as (oo) — so a
        // throw here leaves notified_at unstamped and the advisory re-fires next pass.
        fireReplyRelayNotice(
          runtime,
          item,
          REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE,
          item.inReplyToMessageId
        )
        db.markReplyOutboxNotified(item.id, Date.now())
      }
    }
  } catch (error) {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: item.linkDeviceId,
      verb: 'replyRelay',
      outcome: REPLY_RELAY_BOOKKEEPING_FAILED_CODE,
      reasonCode: JSON.stringify({
        outboxId: item.id,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }
}
