// S10-21b B8/B8c (design §2.5's "already in the ledger" leg, D-R134 F16 / D-R135 A2/F4) —
// inbound message dedupe against `pact_steps` (gate 8a, ledger verbs) and `pact_applied_ids`
// (gate 8b, the four no-ledger verbs), plus the shared cap-checked applied-id write both the
// dispatcher and the resync/resync_request/rebind_party apply modules use. Split out of
// pact-federated-inbound-gates.ts per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import {
  PACT_STEPS_PER_PACT_CAP,
  type ApplyInboundPactVerbArgs,
  type InboundPactVerb
} from './pact-federated-inbound-gates'

// §2.5/§4.5 — the durable applied-id record for the no-ledger verbs (resync/resync_request/
// rebind_party/gap_notice), capped at PACT_STEPS_PER_PACT_CAP. Shared so B9's resync/
// resync_request apply (pact-federated-resync-apply.ts) and B13's rebind_party apply
// (pact-federated-rebind.ts) reuse the exact same cap-checked write the dispatcher uses for
// gap_notice.
export function recordPactAppliedId(
  db: Database.Database,
  threadId: string,
  messageId: string,
  verb: InboundPactVerb
): void {
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM pact_applied_ids WHERE thread_id = ?`)
    .get(threadId) as { n: number }
  if (count.n >= PACT_STEPS_PER_PACT_CAP) {
    throw new OrchestrationError(
      'pact_ledger_capped',
      `Refused: this pact has reached its ${PACT_STEPS_PER_PACT_CAP}-entry no-ledger-verb cap.`
    )
  }
  db.prepare(
    `INSERT INTO pact_applied_ids (thread_id, message_id, verb, applied_at)
       VALUES (?, ?, ?, datetime('now'))`
  ).run(threadId, messageId, verb)
}

export type PactDedupeResult = { outcome: 'fresh' } | { outcome: 'duplicate'; threadId: string }

// Gate 8a — message dedupe against `pact_steps` (ledger verbs), scoped to (link, sender) via the
// thread subquery. Runs BEFORE thread resolution (gate 10) since the subquery supplies its own
// scope. Split from the former combined `runPactDedupeGate` (D-R134 F16 / D-R135 A2): the
// `pact_applied_ids` leg below needs the RESOLVED thread id to be scoped correctly, so it moved
// to run after gate 10 — see `runPactAppliedIdsDedupeGate`.
export function runPactStepsDedupeGate(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs
): PactDedupeResult {
  const existingStep = db
    .prepare(
      `SELECT relay_seq, kind, thread_id FROM pact_steps WHERE message_id = ? AND thread_id IN
         (SELECT id FROM threads WHERE pact_peer_link_device_id = ? AND pact_peer_agent_id = ?)`
    )
    .get(args.messageId, args.pairedDeviceId, args.senderAgentId) as
    | { relay_seq: number | null; kind: string; thread_id: string }
    | undefined
  if (existingStep === undefined) {
    return { outcome: 'fresh' }
  }
  const mismatched =
    existingStep.kind !== args.pact.verb ||
    (existingStep.relay_seq !== null && existingStep.relay_seq !== args.pact.seq)
  if (mismatched) {
    throw new OrchestrationError(
      'request_mismatch',
      `Relayed pact message ${args.messageId} conflicts with an existing pact record on this host.`
    )
  }
  // A genuine duplicate replay — return the stored receipt, apply nothing (§2.5, audited under §2.9).
  return { outcome: 'duplicate', threadId: existingStep.thread_id }
}

// Gate 8b — message dedupe against `pact_applied_ids` (the four no-ledger verbs), scoped to
// (thread_id, message_id) — the table's own PK. MUST run after gate 10 has resolved the local
// thread; the receipt below always names the RESOLVED thread id, never the wire `peerThreadId`
// (D-R134 F16, D-R135 A2/F4: an unscoped, thread-agnostic lookup let a peer pre-register a
// message id on one pact to suppress another peer's verb on a second pact, and the old fallback
// leaked the wire's own `peerThreadId` — a foreign thread id — into the receipt).
export function runPactAppliedIdsDedupeGate(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs,
  threadId: string
): PactDedupeResult {
  const existingApplied = db
    .prepare(`SELECT verb FROM pact_applied_ids WHERE thread_id = ? AND message_id = ?`)
    .get(threadId, args.messageId) as { verb: string } | undefined
  if (existingApplied === undefined) {
    return { outcome: 'fresh' }
  }
  if (existingApplied.verb !== args.pact.verb) {
    throw new OrchestrationError(
      'request_mismatch',
      `Relayed pact message ${args.messageId} conflicts with an existing pact record on this host.`
    )
  }
  return { outcome: 'duplicate', threadId }
}
