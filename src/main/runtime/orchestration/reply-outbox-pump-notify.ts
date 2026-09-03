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
  REPLY_RELAY_RECOVERED_NOTICE,
  LINK_BINDING_RATE_WINDOW_MS
} from './link-binding-constants'

// Ruling 26 Addendum 3(ff)/F7: every settle_raced audit writer on the reply-relay path goes
// through the C3/C4 house `limit:1`-per-window meter (Ruling 23 Addendum 3/5(mm)). These losers
// are local-only (resetMessages/lease reclaim), not peer-drivable, but the house standard
// applies uniformly — one shared writer so pump.ts and pump-hold.ts cannot drift apart.
export function auditReplyRelaySettleRaced(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  item: ReplyOutboxRow,
  cause: string
): void {
  const gate = db.checkAndBumpRate({
    subjectKey: `replyRelay:${item.linkDeviceId}`,
    verb: 'replyRelaySettleRaced',
    windowMs: LINK_BINDING_RATE_WINDOW_MS,
    limit: 1
  })
  if (gate.allowed) {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: item.linkDeviceId,
      verb: 'replyRelay',
      outcome: 'settle_raced',
      reasonCode: JSON.stringify({ outboxId: item.id, cause })
    })
  }
}

// R19.1/P12: assembled entirely from local values; dropped-with-an-audit-row when the item's own
// enqueue-time pane had no current run, never addressed to the synthetic PEER_RUN_ID mailbox.
// Ruling 26 Addendum 4(hh)/(jj): this function no longer stamps last_notified_condition for
// every code — only the DISPOSITION family does, and only through
// fireReplyRelayDispositionNotice below, which stamps BEFORE calling this. Firing the
// unreachable/recovered edge or the R20.2 advisory through this function touches neither notice
// column — those families keep their own separate budgets (unreachable/recovered: the
// consecutive_failures counter; advisory: notified_at + the caller's own per-link map).
export function fireReplyRelayNotice(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  code: ReplyRelayNoticeCode,
  incidentId: string | null
): void {
  const db = runtime.getOrchestrationDb()
  if (item.noticeRunId === null) {
    // Ruling 26 Addendum 2(y): renamed from `notice_dropped_no_run` — Ruling 21 Protocol B2
    // RULED that a notice with no addressable run is NOT a mailbox write; it surfaces as
    // link-status health, this audit row, and `orca orchestration check`'s attention line. The
    // row IS the durable record, so "dropped" was the defect, not the behaviour.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: item.noticePaneKey,
      actorHostId: item.linkDeviceId,
      verb: 'replyRelay',
      outcome: 'notice_surfaced_via_check',
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

// Ruling 26 Addendum 4(hh)/(ii)/(jj): the DISPOSITION family's own notice sender — stale,
// unsupported, unauthorized, abandoned, refused, route_moved, peer_receipt_poisoned,
// id_conflict — every code the disposition table (reply-outbox-pump-disposition.ts) and the
// same-route/no-route hold deadline (reply-outbox-pump-hold.ts) can fire. Stamps
// last_notified_condition + last_notified_at BEFORE sending (guarded to queued/sending rows —
// a no-op for the terminal codes, which settle to a non-queued/sending state before their
// notice fires, exactly as intended: a terminal item never re-fires for itself, so nothing needs
// persisting for it, and the guard is what keeps a settled row's columns untouched).
export function fireReplyRelayDispositionNotice(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  code: ReplyRelayNoticeCode,
  incidentId: string | null
): void {
  runtime.getOrchestrationDb().markReplyOutboxDispositionNotice(item.id, code, Date.now())
  fireReplyRelayNotice(runtime, item, code, incidentId)
}

// H5/Ruling 26(f): the R19.3 health-transition edge, driven ONLY from the row's own persisted
// `consecutive_failures` — never an in-memory Map. That fixes all four defects the C5 review
// found in the Map-keyed version: (a) two queued items on one link overwriting each other's
// edge, (b) a hold's non-failure claim inflating the counter that fires this notice (holds never
// call this function — only a transport-shaped retry does), (c) the edge going silent across a
// restart (a Map has no persistence; a SQLite column does), and (d) one route's delivery
// resetting another route's outage on the same link (this is now per-ITEM, matching the
// per-route claim unit, not per-link).
export function recordReplyOutboxFailureAndMaybeNotify(
  runtime: OrcaRuntimeService,
  item: ReplyOutboxRow,
  nextFailures: number
): void {
  const previous = item.consecutiveFailures
  const transition = classifyFederationRelayHealthTransition(
    { lastSyncAt: null, lastError: null, consecutiveFailures: previous },
    { lastSyncAt: null, lastError: null, consecutiveFailures: nextFailures },
    REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
  )
  if (transition === 'unreachable') {
    fireReplyRelayNotice(runtime, item, REPLY_RELAY_UNREACHABLE_NOTICE, null)
  }
}

// Ruling 26(f): `item` here is the PRE-SETTLE row (its `consecutiveFailures` is whatever the
// failing streak reached before this delivery), which is exactly what "was this link/route
// unreachable" needs to test against.
export function onReplyOutboxDelivered(runtime: OrcaRuntimeService, item: ReplyOutboxRow): void {
  const wasUnreachable = item.consecutiveFailures >= REPLY_OUTBOX_UNREACHABLE_FAILURE_THRESHOLD
  if (wasUnreachable) {
    fireReplyRelayNotice(runtime, item, REPLY_RELAY_RECOVERED_NOTICE, null)
  }
}
