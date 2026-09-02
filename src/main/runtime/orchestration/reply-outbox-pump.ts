// S10-16 C5, R18: the durable reply relay's pump — persisted claim (R18.1), backoff written
// before the dial (R18.2), the delivery deadline (R18.3), the pinned/capability-checked send with
// a bounded hold (R18.4), the committed disposition table (R18.5), the kick (R18.6), resume after
// restart (R18.7) and the closed-enumeration error read (R18.8). Same install pattern as
// `linkBindingProver` — `runtime.replyOutbox`, never a bare module-level singleton.
import type { OrcaRuntimeService } from '../orca-runtime'
import { createInFlightGuard } from './link-binding-schedule'
import { getRoutableLinkBinding } from './link-binding-routable'
import type { ReplyOutboxRow } from './reply-outbox-store'
import { shouldFireReplyRelayNotice } from './reply-outbox-health'
import { classifyReplyRelayError } from './reply-outbox-pump-disposition'
import {
  fireReplyRelayNotice,
  recordReplyOutboxFailureAndMaybeNotify,
  onReplyOutboxDelivered
} from './reply-outbox-pump-notify'
import { holdOrRetargetReplyOutboxItem } from './reply-outbox-pump-hold'
import {
  REPLY_OUTBOX_RPC_BUDGET_MS,
  REPLY_OUTBOX_MAX_AGE_MS,
  REPLY_OUTBOX_HOLD_INTERVAL_MS,
  REPLY_OUTBOX_LINK_CONCURRENCY,
  REPLY_OUTBOX_KICK_DEBOUNCE_MS,
  REPLY_RELAY_ABANDONED_NOTICE,
  REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE
} from './link-binding-constants'

export type ReplyOutboxPump = {
  kick(linkDeviceId: string): void
  health(): { inFlightCount: number }
  pending(linkDeviceId?: string): number
  resumeAfterRestart(): void
  stop(): void
}

type FederatedSendResultShape = {
  accepted: true
  messageId: string
  threadId: string | null
  authorshipUnconfirmed?: boolean
}

export function createReplyOutboxPump(runtime: OrcaRuntimeService): ReplyOutboxPump {
  const inFlightGuard = createInFlightGuard()
  // R19.3's health-transition edge, per link — in-memory only (a restart re-derives from
  // consecutive_failures on the next crossing; an already-unreachable link that stays
  // unreachable across a restart simply does not re-fire until it recovers or fails again from 0).
  const lastKnownFailures = new Map<string, number>()
  const lastAdvisoryNotifiedAt = new Map<string, number>()
  let stopped = false
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let loopRunning = false

  const fireNotice = (
    item: ReplyOutboxRow,
    code: Parameters<typeof fireReplyRelayNotice>[2],
    incidentId: string | null
  ): void => fireReplyRelayNotice(runtime, item, code, incidentId)

  function scheduleWake(delayMs: number): void {
    if (stopped) {
      return
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer)
    }
    wakeTimer = setTimeout(
      () => {
        wakeTimer = null
        void runTickLoop()
      },
      Math.max(0, delayMs)
    )
    wakeTimer.unref?.()
  }

  async function processItem(item: ReplyOutboxRow): Promise<void> {
    const db = runtime.getOrchestrationDb()
    const now = Date.now()

    // R18.3: the delivery deadline, checked before any RPC.
    if (now - item.createdAt > REPLY_OUTBOX_MAX_AGE_MS) {
      db.settleReplyOutboxItem(item.id, {
        state: 'abandoned',
        settledAt: now,
        consecutiveFailures: item.consecutiveFailures,
        nextAttemptAfter: null,
        lastErrorCode: item.lastErrorCode,
        lastError: item.lastError
      })
      fireNotice(item, REPLY_RELAY_ABANDONED_NOTICE, null)
      return
    }

    // R18.4: re-checked EVERY attempt, fresh.
    const binding = getRoutableLinkBinding(db, runtime, item.linkDeviceId)
    if (
      !binding ||
      binding.environmentId !== item.environmentId ||
      binding.boundPairingRevision !== item.boundPairingRevision ||
      binding.peerKeyFingerprint !== item.peerKeyFingerprint
    ) {
      holdOrRetargetReplyOutboxItem(runtime, item, now)
      return
    }

    // ONE try/catch spans the guarded dial AND its disposition (P18-adjacent: a thrown RPC
    // error, wherever it originates in this async chain, must reach the SAME classification
    // below — an error escaping this function unclassified strands the row 'sending' forever,
    // since only claim/settle/hold/retry ever move it out of that state).
    try {
      const guardResult = await inFlightGuard.guarded(
        `pump:${item.environmentId}`,
        REPLY_OUTBOX_RPC_BUDGET_MS,
        async () => {
          return runtime.callPinnedEnvironment({
            selector: item.environmentId,
            method: 'orchestration.federatedSend',
            params: JSON.parse(item.payload),
            timeoutMs: REPLY_OUTBOX_RPC_BUDGET_MS,
            maxDurationMs: REPLY_OUTBOX_RPC_BUDGET_MS,
            expectedEnvironmentPairingRevision: item.boundPairingRevision,
            requireOrchestrationContract: true,
            envelope: { orchestrationRequestId: `reply_relay_${item.id}` }
          })
        }
      )
      if (guardResult === 'busy') {
        // R18.5: a local scheduling collision — never a remote-outage signal.
        db.holdReplyOutboxItem(
          item.id,
          now,
          now + REPLY_OUTBOX_HOLD_INTERVAL_MS,
          item.lastErrorCode ?? ''
        )
        return
      }
      const result = guardResult as FederatedSendResultShape
      db.markPeerRelayAccepted(item.localMessageId, result.threadId)
      db.settleReplyOutboxItem(item.id, {
        state: 'delivered',
        settledAt: Date.now(),
        consecutiveFailures: 0,
        nextAttemptAfter: null,
        lastErrorCode: null,
        lastError: null,
        peerMessageId: result.messageId,
        peerReplyThreadId: result.threadId
      })
      onReplyOutboxDelivered(runtime, lastKnownFailures, item)
      if (result.authorshipUnconfirmed !== true) {
        // R20.2 (v6, protocol M2/lifecycle M1): a clean delivery clears the advisory state.
        db.clearLinkAdvisory(item.linkDeviceId)
      }
      if (result.authorshipUnconfirmed === true) {
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
            lastAdvisoryNotifiedAt.get(item.linkDeviceId) ?? null,
            Date.now()
          )
        ) {
          lastAdvisoryNotifiedAt.set(item.linkDeviceId, Date.now())
          db.markReplyOutboxNotified(item.id, Date.now())
          fireNotice(item, REPLY_RELAY_AUTHORSHIP_UNCONFIRMED_NOTICE, item.inReplyToMessageId)
        }
      }
    } catch (error) {
      const at = Date.now()
      // attempts already bumped at claim time (R18.2) — the item's OWN current attempt count.
      const disposition = classifyReplyRelayError(error, item.attempts, at)
      if (disposition.kind === 'refused') {
        db.settleReplyOutboxItem(item.id, {
          state: 'refused',
          settledAt: at,
          consecutiveFailures: item.consecutiveFailures,
          nextAttemptAfter: null,
          lastErrorCode: disposition.code,
          lastError: disposition.errorMessage
        })
        fireNotice(item, disposition.noticeCode, null)
        return
      }
      db.retryReplyOutboxItem(
        item.id,
        at,
        disposition.nextAttemptAfter,
        item.attempts,
        disposition.disposition,
        disposition.errorMessage
      )
      recordReplyOutboxFailureAndMaybeNotify(runtime, lastKnownFailures, item, item.attempts)
    }
  }

  async function runTickLoop(): Promise<void> {
    if (loopRunning || stopped) {
      return
    }
    loopRunning = true
    try {
      const db = runtime.getOrchestrationDb()
      for (;;) {
        if (stopped) {
          return
        }
        db.reclaimExpiredReplyOutboxLeases(Date.now())
        const claimed: ReplyOutboxRow[] = []
        for (let i = 0; i < REPLY_OUTBOX_LINK_CONCURRENCY; i++) {
          const item = db.claimNextReplyOutboxItem(Date.now())
          if (!item) {
            break
          }
          claimed.push(item)
        }
        if (claimed.length === 0) {
          const nextAttemptAt = db.nextReplyOutboxWakeAt()
          if (nextAttemptAt !== null) {
            scheduleWake(Math.max(0, nextAttemptAt - Date.now()))
          }
          return
        }
        await Promise.allSettled(claimed.map((item) => processItem(item)))
      }
    } finally {
      loopRunning = false
    }
  }

  return {
    kick(linkDeviceId: string): void {
      const db = runtime.getOrchestrationDb()
      db.kickReplyOutboxForLink(linkDeviceId, Date.now())
      if (wakeTimer) {
        clearTimeout(wakeTimer)
      }
      wakeTimer = setTimeout(() => {
        wakeTimer = null
        void runTickLoop()
      }, REPLY_OUTBOX_KICK_DEBOUNCE_MS)
      wakeTimer.unref?.()
    },
    health(): { inFlightCount: number } {
      return { inFlightCount: inFlightGuard.size() }
    },
    pending(linkDeviceId?: string): number {
      if (linkDeviceId !== undefined) {
        return runtime.getOrchestrationDb().countPendingReplyOutbox(linkDeviceId)
      }
      return runtime
        .getOrchestrationDb()
        .listReplyOutbox()
        .filter((r) => r.state === 'queued' || r.state === 'sending').length
    },
    // R18.7: reclaim (synchronous, against the db that is open right now), then arm a tick ONLY
    // if there is actual pending work. An empty outbox (the common case: every test and every
    // idle host) stays fully inert — no deferred timer, nothing left running past this call.
    // Optional chaining on both calls (matching this file's own `getCurrentRunForPane?.` idiom,
    // orca-runtime.ts): many pre-existing tests install a partial `OrchestrationDb` stub via
    // `setOrchestrationDb({...} as never)` that predates this slice and implements neither
    // method — this arm site must stay a no-op against one, never a thrown TypeError.
    resumeAfterRestart(): void {
      if (stopped) {
        return
      }
      const db = runtime.getOrchestrationDb()
      if (typeof db.reclaimExpiredReplyOutboxLeases !== 'function') {
        return
      }
      db.reclaimExpiredReplyOutboxLeases(Date.now())
      const nextAt = db.nextReplyOutboxWakeAt()
      if (nextAt !== null) {
        scheduleWake(Math.max(0, nextAt - Date.now()))
      }
    },
    stop(): void {
      stopped = true
      if (wakeTimer) {
        clearTimeout(wakeTimer)
        wakeTimer = null
      }
    }
  }
}
