// R223b: a per-pane polling guard on the bus-read verbs. A pane that reads the read-only bus
// verbs (orchestration.check / .inbox / agents threads.get / threads.list / thread.get) above a
// fixed budget in a fixed window is refused with a typed `polling_detected` error naming the
// rule, audited once per window — single reads, `check --wait`, every ack form, `agents wait`,
// unattested callers and paired devices are unaffected. See design doc D-R209 (referenced by
// brief b1-10y-r223) for the rationale.
import type { RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor } from './agent-directory-rpc-view'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'

export const BUS_POLL_WINDOW_MS = 60_000
export const BUS_POLL_LIMIT_PER_WINDOW = 60
export const POLLING_DETECTED_CODE = 'polling_detected'

const BUS_POLL_RATE_VERB = 'bus_poll'
const BUS_POLL_AUDIT_RATE_VERB = 'bus_poll_audit'
const BUS_POLL_AUDIT_VERB = 'bus_poll'

// [deviation, A3b] The fifth verb's registered RPC method name is 'orchestration.thread' (see
// orchestration-thread.ts:140), not 'orchestration.thread.get' as named in the brief's prose —
// used here verbatim so `method` always matches what the dispatcher/CLI actually calls it.
export type BusPollMethod =
  | 'orchestration.check'
  | 'orchestration.inbox'
  | 'orchestration.threads.get'
  | 'orchestration.threads.list'
  | 'orchestration.thread'

/** True only when `params` is a plain (non-blocking, non-ack) read: `wait !== true` and none of
 * the ack forms (ack / compatibilityAck / compatibilityQuestionAck) are present. Used to exempt
 * `check --wait` and every ack form from the polling budget. */
export function isBusPollCheck(params: unknown): boolean {
  const p = (params ?? {}) as Record<string, unknown>
  return (
    p.wait !== true &&
    p.ack === undefined &&
    p.compatibilityAck === undefined &&
    p.compatibilityQuestionAck === undefined
  )
}

/** Refuses with `polling_detected` once a pane has read the bus-read verbs more than
 * BUS_POLL_LIMIT_PER_WINDOW times in the current BUS_POLL_WINDOW_MS window. Unattested callers
 * (no resolvable authority) are never counted. Audits the refusal once per window, best-effort —
 * an audit-write failure never blocks or changes the refusal. */
export function assertNotBusPolling(
  runtime: RpcContext['runtime'],
  evidence: OrchestrationCompatibilityEvidence | null | undefined,
  method: BusPollMethod
): void {
  const authority = runtime.verifyOrchestrationCompatibilityCaller(evidence, {
    currentRuntimeLaunchSufficient: true
  })
  if (!authority) {
    // Unattested callers are never counted.
    return
  }
  const db = runtime.getOrchestrationDb()
  const rate = db.checkAndBumpRate({
    subjectKey: authority.paneKey,
    verb: BUS_POLL_RATE_VERB,
    windowMs: BUS_POLL_WINDOW_MS,
    limit: BUS_POLL_LIMIT_PER_WINDOW
  })
  if (rate.allowed) {
    return
  }
  const auditRate = db.checkAndBumpRate({
    subjectKey: authority.paneKey,
    verb: BUS_POLL_AUDIT_RATE_VERB,
    windowMs: BUS_POLL_WINDOW_MS,
    limit: 1
  })
  if (auditRate.allowed) {
    const hostId = hostIdFor(runtime)
    try {
      db.writeAgentAudit({
        agentId: db.getAgentByPaneKey(hostId, authority.paneKey)?.id ?? null,
        actorPaneKey: authority.paneKey,
        actorHostId: hostId,
        verb: BUS_POLL_AUDIT_VERB,
        outcome: 'polling_detected',
        reasonCode: `method=${method} limit=${BUS_POLL_LIMIT_PER_WINDOW} window_ms=${BUS_POLL_WINDOW_MS}`
      })
    } catch {
      // Best-effort: the audit write never blocks or changes the refusal outcome.
    }
  }
  throw new OrchestrationError(
    POLLING_DETECTED_CODE,
    'polling detected; new mail is delivered to this pane when it is idle; use orca agents wait ' +
      `(limit: ${BUS_POLL_LIMIT_PER_WINDOW} reads of orchestration check/inbox/thread and agents threads/thread per pane per ${BUS_POLL_WINDOW_MS / 1000}s)`,
    {
      effectsApplied: false,
      retryAfterMs: rate.retryAfterMs,
      limit: BUS_POLL_LIMIT_PER_WINDOW,
      windowMs: BUS_POLL_WINDOW_MS,
      nextSteps: [
        'stop the polling loop; new mail is delivered to this pane when it is idle',
        'to block on one thread: orca agents wait --thread <thread-id>',
        "run coordinators and workers: orca orchestration check --wait (a registered agent's own mailbox does not park; rely on the delivered mail or agents wait)"
      ]
    }
  )
}
