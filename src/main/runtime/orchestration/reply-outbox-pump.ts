// S10-16 C5, R18: the durable reply relay's pump — persisted claim (R18.1), backoff written
// before the dial (R18.2), the delivery deadline (R18.3), the pinned/capability-checked send with
// a bounded hold (R18.4), the committed disposition table (R18.5), the kick (R18.6), resume after
// restart (R18.7) and the closed-enumeration error read (R18.8). Same install pattern as
// `linkBindingProver` — `runtime.replyOutbox`, never a bare module-level singleton.
import type { OrcaRuntimeService } from '../orca-runtime'
import { createInFlightGuard } from './link-binding-schedule'
import { getRoutableLinkBinding } from './link-binding-routable'
import type { ReplyOutboxRow } from './reply-outbox-store'
import { classifyReplyRelayError } from './reply-outbox-pump-disposition'
import {
  fireReplyRelayNotice,
  recordReplyOutboxFailureAndMaybeNotify
} from './reply-outbox-pump-notify'
import { holdOrRetargetReplyOutboxItem } from './reply-outbox-pump-hold'
import {
  settleReplyOutboxDelivery,
  type FederatedSendResultShape
} from './reply-outbox-pump-deliver'
import {
  REPLY_OUTBOX_RPC_BUDGET_MS,
  REPLY_OUTBOX_MAX_AGE_MS,
  REPLY_OUTBOX_HOLD_INTERVAL_MS,
  REPLY_OUTBOX_LINK_CONCURRENCY,
  REPLY_OUTBOX_KICK_DEBOUNCE_MS,
  REPLY_RELAY_ABANDONED_NOTICE
} from './link-binding-constants'

export type ReplyOutboxPump = {
  kick(linkDeviceId: string): void
  health(): { inFlightCount: number }
  pending(linkDeviceId?: string): number
  resumeAfterRestart(): void
  stop(): void
}

export function createReplyOutboxPump(runtime: OrcaRuntimeService): ReplyOutboxPump {
  const inFlightGuard = createInFlightGuard()
  const lastAdvisoryNotifiedAt = new Map<string, number>()
  let stopped = false
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let loopRunning = false
  // M13 (C5 review)/Ruling 26(l): a kick landing while a tick is already running must not be
  // dropped — its own debounce-fired call into runTickLoop sees `loopRunning` and would
  // otherwise just no-op. This flag is consumed at the running tick's own tail.
  let rerunRequested = false

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
      // Ruling 26 Addendum 1(q)/F4: the settle's boolean is checked — a lost write (the row was
      // cancelled underneath this call) must never fire the notice.
      const settled = db.settleReplyOutboxItem(item.id, {
        state: 'abandoned',
        settledAt: now,
        consecutiveFailures: item.consecutiveFailures,
        nextAttemptAfter: null,
        lastErrorCode: item.lastErrorCode,
        lastError: item.lastError
      })
      if (settled) {
        fireNotice(item, REPLY_RELAY_ABANDONED_NOTICE, null)
      } else {
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: item.linkDeviceId,
          verb: 'replyRelay',
          outcome: 'settle_raced',
          reasonCode: JSON.stringify({ outboxId: item.id, cause: 'abandoned' })
        })
      }
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

    // ONE try/catch spans ONLY the guarded dial (H6/Ruling 26(g) — post-delivery bookkeeping,
    // below, is deliberately OUTSIDE it: a thrown RPC error, wherever it originates in this
    // async chain, must reach the SAME classification below, since only claim/settle/hold/retry
    // ever move the row out of 'sending'; but a throw AFTER a successful settle is a local
    // bookkeeping fault, never a transport failure and never a retry of a delivered row).
    let guardResult: 'busy' | FederatedSendResultShape
    try {
      guardResult = (await inFlightGuard.guarded(
        // M10 (C5 review)/Ruling 26(j): keyed per ROUTE (link + environment), not per
        // environment alone — two routes to one environment (old/new bound_pairing_revision,
        // i.e. exactly the re-pair case) must not collide with each other.
        `pump:${item.linkDeviceId}:${item.environmentId}`,
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
      )) as 'busy' | FederatedSendResultShape
    } catch (error) {
      const at = Date.now()
      // Ruling 26 Addendum 1(r)/F5: the backoff curve is keyed on the row's own persisted
      // consecutive_failures — the SAME counter the claim (reply-outbox-lifecycle.ts) and the
      // unreachable/recovered edge use — never on `item.attempts` (which bumps on every claim,
      // including ones that end in a hold, and diverges from consecutive_failures under B1).
      const disposition = classifyReplyRelayError(error, item.consecutiveFailures, at)
      if (disposition.kind === 'refused') {
        // Ruling 26 Addendum 1(q)/F4: check the settle's boolean before firing.
        const settled = db.settleReplyOutboxItem(item.id, {
          state: 'refused',
          settledAt: at,
          consecutiveFailures: item.consecutiveFailures,
          nextAttemptAfter: null,
          lastErrorCode: disposition.code,
          lastError: disposition.errorMessage
        })
        if (settled) {
          fireNotice(item, disposition.noticeCode, null)
        } else {
          db.writeAgentAudit({
            agentId: null,
            actorPaneKey: null,
            actorHostId: item.linkDeviceId,
            verb: 'replyRelay',
            outcome: 'settle_raced',
            reasonCode: JSON.stringify({ outboxId: item.id, cause: 'refused' })
          })
        }
        return
      }
      if (disposition.kind === 'recheck') {
        // M9/R18.5's `runtime_environment_changed` row: no failure bump, immediate re-check
        // through the SAME routable-binding path the top of this function already runs.
        holdOrRetargetReplyOutboxItem(runtime, item, at)
        return
      }
      // H5/Ruling 26(f): consecutive_failures is driven from the row's OWN persisted counter,
      // never `item.attempts` (which bumps on every claim, including ones that end in a hold).
      const nextFailures = disposition.bumpFailure
        ? item.consecutiveFailures + 1
        : item.consecutiveFailures
      // Ruling 26 Addendum 1(q)/F4: the retry's boolean is checked — a lost write (a concurrent
      // resetMessages/reclaim mid-flight) must persist nothing, fire nothing, and never let the
      // next claim re-cross a threshold on a counter that was never written.
      const wrote = db.retryReplyOutboxItem(
        item.id,
        at,
        disposition.nextAttemptAfter,
        nextFailures,
        disposition.disposition,
        disposition.errorMessage
      )
      if (!wrote) {
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: item.linkDeviceId,
          verb: 'replyRelay',
          outcome: 'settle_raced',
          reasonCode: JSON.stringify({ outboxId: item.id, cause: 'retry' })
        })
        return
      }
      if (disposition.bumpFailure) {
        recordReplyOutboxFailureAndMaybeNotify(runtime, item, nextFailures)
      }
      // Ruling 26 Addendum 1(o)/F2: edge-triggered on persisted state — a disposition notice
      // fires only on the transition INTO this disposition (item.lastErrorCode is the
      // pre-write value read at claim time), never on every retry. `last_error_code` was just
      // written by the retryReplyOutboxItem call above, so the edge is durable and survives a
      // restart for free — the same discipline Ruling 26(f) applies to the unreachable edge.
      if (disposition.noticeCode && item.lastErrorCode !== disposition.disposition) {
        fireNotice(item, disposition.noticeCode, null)
      }
      return
    }

    if (guardResult === 'busy') {
      // R18.5/Ruling 26(j): a local scheduling collision — never a remote-outage signal, and
      // (unlike holdReplyOutboxItem) never starts the R18.3 abandon clock.
      db.holdReplyOutboxItemCollision(item.id, now + REPLY_OUTBOX_HOLD_INTERVAL_MS)
      return
    }

    settleReplyOutboxDelivery(runtime, item, guardResult, lastAdvisoryNotifiedAt)
  }

  async function runTickLoop(): Promise<void> {
    if (loopRunning || stopped) {
      // M13/Ruling 26(l): a kick's debounced call landing while the loop is already running
      // must not be silently dropped — flag it for the running tick's own tail to consume.
      if (loopRunning && !stopped) {
        rerunRequested = true
      }
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
      if (rerunRequested) {
        rerunRequested = false
        scheduleWake(0)
      }
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
