// Ruling 28(f)/(g) (C8a): `orchestration.replyOutbox` — split out of
// orchestration-link-binding-local.ts (max-lines). `--outbox` (list) projects host-constant
// columns only and renders `last_error` through the ONE R19.4 renderer; `--drain` wakes the pump
// through `runtime.replyOutbox.kick` (never a bare DB write) and reports honestly — the
// pre-kick queued count, labelled `kicked`, never a number implying the drain already finished.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { requireLocalCaller } from './orchestration-link-binding-caller-gate'
import { sanitizeErrorDetail } from '../../orchestration/reply-outbox-pump-disposition'
import { LINK_BINDING_PEER_TEXT_CLAMP } from '../../orchestration/link-binding-constants'
import type { ReplyOutboxRow } from '../../orchestration/reply-outbox-store'

// R19.4/design test 37: the ONE render of a peer-supplied `last_error` reaching an operator —
// quoted, control-stripped, clamped, and labelled so it can never be mistaken for this host's own
// diagnosis.
function renderPeerSuppliedError(raw: string | null): string | null {
  if (raw === null) {
    return null
  }
  const clean = sanitizeErrorDetail(raw).slice(0, LINK_BINDING_PEER_TEXT_CLAMP)
  return `text supplied by the remote host: "${clean}"`
}

// F-7: host-constant columns plus the one sanitized peer-text field — never `payload` (the full
// relayed reply body) and never the raw `last_error`.
function projectOutboxRow(row: ReplyOutboxRow): Record<string, unknown> {
  return {
    id: row.id,
    linkDeviceId: row.linkDeviceId,
    environmentId: row.environmentId,
    state: row.state,
    attempts: row.attempts,
    consecutiveFailures: row.consecutiveFailures,
    holdCount: row.holdCount,
    firstHeldAt: row.firstHeldAt,
    nextAttemptAfter: row.nextAttemptAfter,
    lastErrorCode: row.lastErrorCode,
    lastError: renderPeerSuppliedError(row.lastError),
    createdAt: row.createdAt,
    settledAt: row.settledAt
  }
}

const ReplyOutboxParams = z
  .object({ link: z.string().optional(), drain: z.boolean().optional() })
  .strict()

const REPLY_OUTBOX_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.replyOutbox',
  params: ReplyOutboxParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const db = ctx.runtime.getOrchestrationDb()
    if (params.drain) {
      const ids = params.link
        ? [params.link]
        : [...new Set(db.listReplyOutbox().map((row) => row.linkDeviceId))]
      // F-8: wakes the pump through the SAME kick the peer's own inbound-contact path uses
      // (`runtime.replyOutbox.kick`) rather than the bare DB write C7 shipped — a bare write
      // rewrote `next_attempt_after` but never armed the pump's own tick, so a drain that ran
      // with no other traffic slept until whatever wake was already scheduled.
      const kicked: Record<string, number> = {}
      for (const linkDeviceId of ids) {
        // Honest reporting (F-8): this is the count BEFORE the kick's debounced tick runs — the
        // pump's `kick()` is fire-and-forget (R18.6), so the RPC cannot await "after the tick"
        // without blocking on the pump's own timer. Labelled `kicked`, never `pending`, so it is
        // never read as the post-drain result.
        kicked[linkDeviceId] = db.countPendingReplyOutbox(linkDeviceId)
        ctx.runtime.replyOutbox?.kick(linkDeviceId)
      }
      return { kicked }
    }
    return { items: db.listReplyOutbox(params.link).map(projectOutboxRow) }
  }
})

export const ORCHESTRATION_LINK_BINDING_OUTBOX_METHODS: RpcMethod[] = [REPLY_OUTBOX_METHOD]
