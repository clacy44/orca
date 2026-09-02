// S10-16 C5, R19: the pump's notice assembly + P12's no-run drop — split out of
// reply-outbox-pump.ts to stay under the max-lines ratchet.
import type { OrcaRuntimeService } from '../orca-runtime'
import { postRuntimeNotification } from './runtime-notification'
import { classifyFederationRelayHealthTransition } from './federation-sync-health'
import { describeReplyRelayNotice, type ReplyRelayNoticeCode } from './reply-outbox-health'
import type { ReplyOutboxRow } from './reply-outbox-store'
import {
  REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD,
  REPLY_RELAY_UNREACHABLE_NOTICE,
  REPLY_RELAY_RECOVERED_NOTICE
} from './link-binding-constants'

// R19.1/P12: assembled entirely from local values; dropped-with-an-audit-row when the item's own
// enqueue-time pane had no current run, never addressed to the synthetic PEER_RUN_ID mailbox.
export function fireReplyRelayNotice(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  code: ReplyRelayNoticeCode,
  incidentId: string | null
): void {
  const db = runtime.getOrchestrationDb()
  if (item.noticeRunId === null) {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: item.noticePaneKey,
      actorHostId: item.linkDeviceId,
      verb: 'replyRelay',
      outcome: 'notice_dropped_no_run',
      reasonCode: JSON.stringify({ outboxId: item.id, localMessageId: item.localMessageId, code })
    })
    return
  }
  const environmentName = (() => {
    try {
      return runtime.resolveOrchestrationWorkerServer(item.environmentId).name
    } catch {
      return item.environmentId
    }
  })()
  const queueDepth = db.countPendingReplyOutbox(item.linkDeviceId)
  const { subject, body } = describeReplyRelayNotice(code, {
    environmentName,
    linkDeviceId: item.linkDeviceId,
    outboxId: item.id,
    localMessageId: item.localMessageId,
    queueDepth,
    oldestAgeMs: Date.now() - item.createdAt,
    attempts: item.attempts,
    peerRefusalCode: item.lastErrorCode,
    incidentId
  })
  postRuntimeNotification({
    db,
    runtime,
    runId: item.noticeRunId,
    subject,
    body,
    payload: { kind: code }
  })
}

// R19.3's health-transition edge, per link. `lastKnownFailures` is owned by the caller (the
// pump) and passed in — this stays a pure-ish function over that Map, in-memory only (a restart
// re-derives from consecutive_failures on the next crossing).
export function recordReplyOutboxFailureAndMaybeNotify(
  runtime: OrcaRuntimeService,
  lastKnownFailures: Map<string, number>,
  item: ReplyOutboxRow,
  nextFailures: number
): void {
  const previous = lastKnownFailures.get(item.linkDeviceId) ?? 0
  lastKnownFailures.set(item.linkDeviceId, nextFailures)
  const transition = classifyFederationRelayHealthTransition(
    { lastSyncAt: null, lastError: null, consecutiveFailures: previous },
    { lastSyncAt: null, lastError: null, consecutiveFailures: nextFailures },
    REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
  )
  if (transition === 'unreachable') {
    fireReplyRelayNotice(runtime, item, REPLY_RELAY_UNREACHABLE_NOTICE, null)
  }
}

export function onReplyOutboxDelivered(
  runtime: OrcaRuntimeService,
  lastKnownFailures: Map<string, number>,
  item: ReplyOutboxRow
): void {
  const wasUnreachable =
    (lastKnownFailures.get(item.linkDeviceId) ?? 0) >= REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
  lastKnownFailures.set(item.linkDeviceId, 0)
  if (wasUnreachable) {
    fireReplyRelayNotice(runtime, item, REPLY_RELAY_RECOVERED_NOTICE, null)
  }
}
