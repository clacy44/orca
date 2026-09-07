// S10-21b B13 (design §1.4(b), §2.10, §2.11; Ruling 34 Addendum 4/6(1)) — `rebind_party`: the
// inbound six-clause apply (the REMOTE side of §1.4's re-registration story) and the pump-side
// drain of the `pact_relay_pending = 'rebind'` flag the LOCAL side's succession UPDATE
// (agent-thread-succession.ts) queues. Split from pact-federated-inbound-apply.ts (max-lines
// ratchet) and from pact-federated-emit.ts (this module needs `agents`-table predecessor
// lookups neither of those already imports).
//
// Clauses 1 (link routable+unquarantined) and 2 (identity import outcome === 'imported') are
// NOT re-implemented here — they already run generically for every pact verb, upstream of this
// module: clause 1 is gate 9 (`getRoutableLinkBinding`, orchestration-federated-peer-send-pact-
// inbound.ts:83-87) plus containment's `refuseIfQuarantined` (orchestration-federated-peer-
// send.ts:96-98, which `getRoutableLinkBinding` also re-checks via `isPeerLinkQuarantined` —
// link-binding-liveness.ts:93); clause 2 is gate 6 (same file:69-76, `pact_identity_unmirrored`
// — the CHAIR ANSWER for B13's OPEN item 7 reuses this code verbatim, never a `rebind`-specific
// variant). Clause 6 (era equality) is gate 11 (pact-federated-inbound-gates.ts) — `rebind_party`
// is not `propose`, so gate 11's unconditional era-equality check already applies to it with no
// adoption carve-out, exactly as design §1.4(b) clause 6 requires. Only clauses 3, 4, 5 are new
// code, below.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { writeAgentAudit } from './agent-audit-log'
import { auditPact } from './pact-shared'
import { autoPausePactOnThread } from './pact-lifecycle'
import { renderFederatedPartyKey, repointFederatedPactParty } from './pact-federated-identity'
import type { ApplyInboundPactVerbArgs } from './pact-federated-inbound-gates'
import { recordPactAppliedId } from './pact-federated-inbound-dedupe'
import type { InboundPactWake } from './pact-federated-inbound-wake'
import type { ThreadRow } from './thread-directory-types'
import { enqueueFederatedPactVerb, type FederatedPactEmitRuntime } from './pact-federated-emit'
import { emitFederatedPactSideEffect } from './pact-federated-pause-resume-emit'

export type RebindPartyApplyResult = {
  accepted: true
  messageId: string
  threadId: string
  wake: InboundPactWake
}

// The ONE bounded chain-walk (B2, design §4.7) lives as an `OrchestrationDb` METHOD, not a free
// function (README NOTE, after B2) — this module only ever holds the raw `Database.Database`
// handle (same constraint pact-federated-identity.ts documents for
// `isRemoteAgentLocallyQuarantinedAnywhere`), so `db.ts`'s `applyInboundPactVerb` method threads
// its own `this.walkRemoteAgentSupersessionChain` bound method through as this callback rather
// than this module re-deriving the walk (forbidden — common-rules DO NOT list).
export type SupersessionChainWalker = (remoteAgentId: string, linkKey: string) => string[]

// §1.4(b)'s six-clause apply, clauses 3-5 (1/2/6 inherited — see header). One read-only pass
// (chair transaction-shape answer, README "CHAIR ANSWERS for B13"), THEN two sequential
// transactions: `repointFederatedPactParty` (B3, its own `BEGIN IMMEDIATE` — cannot nest, batch-1
// review F5) followed by a second `BEGIN IMMEDIATE` for the supersede-stamp + ledger/applied-id
// write. Never touches `pact_state`/`pact_ordinal`/turn ownership/any pause flag/our own side's
// columns (design's explicit "never touches" list).
export function applyInboundRebindPartyVerb(
  db: Database.Database,
  thread: ThreadRow,
  args: ApplyInboundPactVerbArgs,
  walkSupersessionChain: SupersessionChainWalker
): RebindPartyApplyResult {
  const rebind = args.pact.rebind
  if (!rebind) {
    throw new OrchestrationError(
      'invalid_argument',
      'The relayed rebind_party envelope is missing rebind.oldAgentId.',
      { reasonCode: 'malformed_relay_id' }
    )
  }
  const oldAgentId = rebind.oldAgentId
  const newAgentId = args.senderAgentId
  const linkKey = args.pairedDeviceId

  // Clause 3: the mirror row (linkKey, oldAgentId) exists, is not ALREADY superseded (idempotency
  // — a retry carrying a fresh messageId, not caught by gate 8's message-id dedupe, must still be
  // a no-op: once `oldAgentId` is superseded the lookup fails harmlessly rather than re-repointing
  // and re-auditing), and its display_name equals the new identity's sanitized display name
  // (already upserted onto the (linkKey, newAgentId) row by gate 6's `imported.outcome ===
  // 'imported'` importer, ahead of this call).
  const oldMirror = db
    .prepare(
      `SELECT display_name, superseded_at FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
    )
    .get(linkKey, oldAgentId) as { display_name: string; superseded_at: string | null } | undefined
  const newMirror = db
    .prepare(
      `SELECT display_name FROM remote_agents WHERE environment_id = ? AND remote_agent_id = ?`
    )
    .get(linkKey, newAgentId) as { display_name: string } | undefined
  if (
    !oldMirror ||
    oldMirror.superseded_at !== null ||
    !newMirror ||
    oldMirror.display_name !== newMirror.display_name
  ) {
    throw new OrchestrationError(
      'agent_unknown',
      `Refused: no live mirrored identity on this link matches rebind.oldAgentId (${oldAgentId}) with a display name matching the new identity.`
    )
  }

  // Clause 4: no row in oldAgentId's supersession chain is `local_quarantined`. Same
  // remote_agent_id-only union errata E1 already uses (pact-federated-identity.ts's
  // `isRemoteAgentLocallyQuarantinedAnywhere`) — a peer agent quarantined on its OTHER
  // (paired_device vs environment) row must still be refused here.
  const chain = walkSupersessionChain(oldAgentId, linkKey)
  const quarantinedInChain = chain.some(
    (id) =>
      db
        .prepare(`SELECT 1 FROM remote_agents WHERE remote_agent_id = ? AND local_quarantined = 1`)
        .get(id) !== undefined
  )
  if (quarantinedInChain) {
    writeAgentAudit(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: 'pact_rebind_party',
      outcome: 'agent_quarantined',
      reasonCode: 'counterpart_quarantined'
    })
    // Own transaction (pact-lifecycle.ts) — never nested inside one of this function's own.
    autoPausePactOnThread(db, thread.id, 'counterpart_quarantined')
    throw new OrchestrationError(
      'agent_quarantined',
      `Refused: a row in ${oldAgentId}'s supersession chain is locally quarantined.`,
      { nextSteps: ['orca agents ask'] }
    )
  }

  // Clause 5 (S10-21b B17, D-R137 F3): `remote:<link>:<oldAgentId>` OR
  // `remote:<link>:<newAgentId>` must be a party to this pact. The new-key case is the
  // self-repair for a crash between step 1 (repoint) and step 2 (supersede-stamp + applied-id)
  // below: after step 1 alone, `threads.pact_*_agent_id` already reads the NEW rendered key
  // while `oldMirror.superseded_at` is still NULL (that stamp is step 2's own write) — so a
  // retry of the identical wire message reaches this clause with the party already repointed.
  // Refusing it here (checking only the old key) meant clause 3's own idempotency claim never
  // actually applied and every retry threw `not_a_participant` forever. Clause 3's
  // `superseded_at IS NULL` check still keeps a FULLY completed rebind (old mirror superseded)
  // from re-entering — it throws `agent_unknown` before this clause is ever reached.
  const oldPartyKey = renderFederatedPartyKey({ linkDeviceId: linkKey, remoteAgentId: oldAgentId })
  const newPartyKey = renderFederatedPartyKey({ linkDeviceId: linkKey, remoteAgentId: newAgentId })
  const isParty = (key: string): boolean =>
    thread.pact_proposer_agent_id === key || thread.pact_with_agent_id === key
  if (!isParty(oldPartyKey) && !isParty(newPartyKey)) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: ${oldPartyKey} is not a party to the pact on ${thread.id}.`
    )
  }

  // Effect (design "Effect:" paragraph) — step 1: repoint, in its OWN transaction (unchanged,
  // never restructured to take an outer one — batch-1 review F5/CHAIR ANSWER).
  repointFederatedPactParty(db, thread.id, {
    linkDeviceId: linkKey,
    environmentId: args.senderEnvironmentId,
    remoteAgentId: newAgentId,
    reason: 'rebind_party'
  })

  // Effect — step 2: supersede-stamp the old mirror row + the applied-id/ledger write, a SECOND
  // `BEGIN IMMEDIATE` (chair transaction-shape answer). A crash between step 1 and step 2 is
  // repaired by clause 3's own idempotency on retry (repoint is a no-op once
  // `threads.pact_peer_agent_id` already reads `newAgentId`; the applied-id write below still
  // lands, closing the window) — never a reason to merge the two transactions.
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE remote_agents SET superseded_at = datetime('now'), succeeded_by_remote_agent_id = ?
       WHERE environment_id = ? AND remote_agent_id = ?`
    ).run(newAgentId, linkKey, oldAgentId)
    recordPactAppliedId(db, thread.id, args.messageId, 'rebind_party')
    db.prepare(`UPDATE threads SET pact_last_inbound_at = datetime('now') WHERE id = ?`).run(
      thread.id
    )
    auditPact(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.pairedDeviceId,
      verb: 'pact_rebind_party',
      outcome: 'applied'
    })
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { accepted: true, messageId: args.messageId, threadId: thread.id, wake: { kind: 'none' } }
}

// B9c (D-R134 F3/D-R135 F2, chair NOTE "after B13"): extends this SAME drain to
// `pact_relay_pending = 'gap_notice'` (the terminal-settle emitter-push, repair.ts's own
// `cancelPactTailAndPause`) — one scan, a per-token emit, never a second scan.
function drainGapNotice(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null,
  threadId: string
): number {
  const result = enqueueFederatedPactVerb(db, runtime, threadId, 'gap_notice', {
    actorAgentId: null,
    actorPaneKey: null,
    actorHostId: null,
    runId: 'host'
  })
  if (result.outcome !== 'enqueued') {
    return 0
  }
  db.prepare(
    `UPDATE threads SET pact_relay_pending = NULL WHERE id = ? AND pact_relay_pending = 'gap_notice'`
  ).run(threadId)
  return 1
}

// S10-21b B17 (D-R137 F10, D-R138 F5/A-F7/B-F11): re-attempts a pause/resume side effect a
// LinkBindingCapError left pending — the whole `enqueueFederatedPactVerb` transaction rolled
// back with that error (nothing, not even the thread state, was applied), so a clean full
// re-invocation of `emitFederatedPactSideEffect` is correct and cannot double-write anything.
// DISCLOSED DEVIATION: the original caller's actor identity and (for `pause`) its specific
// `reason_code` are lost with the rollback — the retry is host-actor with a generic reason
// (`emitFederatedPactSideEffect`'s own `reasonCode=null` folds to `pact_pause_reason='operator'`
// for `pause`; `resume` never carries one). Preferable to the base's silent, permanent
// local-only degradation with no retry at all.
function drainPausedOrResumed(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null,
  threadId: string,
  token: 'pause' | 'resume'
): number {
  // Clear the token FIRST — `emitFederatedPactSideEffect` re-sets it itself if the cap is still
  // hit, so this is never a lost-update window, only a harmless double-scan on the next tick.
  db.prepare(
    `UPDATE threads SET pact_relay_pending = NULL WHERE id = ? AND pact_relay_pending = ?`
  ).run(threadId, token)
  emitFederatedPactSideEffect(db, runtime, threadId, token, null)
  return 1
}

// Per-token relay_kind this drain's own double-emit guard checks against — S10-21b B17
// (D-R138 A-F7/B-F11): the base guard was a single `NOT EXISTS (... relay_kind = 'pact_gap_notice')`
// shared by EVERY token, so a queued gap_notice blocked the rebind drain (and vice versa) for as
// long as the unrelated relay stayed unsettled. Each token now checks only its OWN relay_kind.
const RELAY_PENDING_TOKEN_RELAY_KIND: Record<string, string> = {
  gap_notice: 'pact_gap_notice',
  rebind: 'pact_rebind_party',
  pause: 'pact_pause',
  resume: 'pact_resume'
}

// §1.4's Local side / §2.11 — drains every thread flagged `pact_relay_pending = 'rebind'` (the
// succession UPDATE, agent-thread-succession.ts), `'gap_notice'` (B9c, above), or `'pause'`/
// `'resume'` (B17, above), emitting `rebind_party`/`gap_notice`/pause/resume via B6's shared
// primitive (or, for pause/resume, `emitFederatedPactSideEffect` directly). Deliberately NOT
// called from inside `upsertAgentByPaneSuffix`'s own transaction (the design's explicit "no
// enqueue runs inside that transaction" constraint) — this is the PUMP's own, separate call
// (reply-outbox-pump.ts, once per tick, ahead of its ordinary claim loop).
export function drainPendingRebindParty(
  db: Database.Database,
  runtime: FederatedPactEmitRuntime | null
): number {
  // N7: enqueueFederatedPactVerb opens its OWN `BEGIN IMMEDIATE` (SQLite cannot nest), so the
  // token clear cannot land inside its transaction — FORCED DEVIATION from the brief's preferred
  // shape. The per-token NOT EXISTS guard alone closes the window: a crash between the enqueue
  // commit and the token-clear UPDATE leaves the token set, but this guard then excludes the
  // thread from the NEXT tick's scan (the just-enqueued row is still 'queued'/'sending'), so no
  // second emit of the SAME kind is minted; the token itself is cleared, late, whenever that
  // tick's clear runs (or never, if the crash also lost the clear — a stuck token only ever
  // suppresses a re-mint, per errata 21b-E5, never blocks anything else).
  const rows = db
    .prepare(
      `SELECT id, pact_relay_pending, pact_proposer_agent_id, pact_with_agent_id FROM threads
       WHERE pact_relay_pending IN ('rebind', 'gap_notice', 'pause', 'resume')
         AND pact_peer_agent_id IS NOT NULL AND purged_at IS NULL`
    )
    .all() as {
    id: string
    pact_relay_pending: string
    pact_proposer_agent_id: string | null
    pact_with_agent_id: string | null
  }[]

  let drained = 0
  for (const row of rows) {
    const relayKind = RELAY_PENDING_TOKEN_RELAY_KIND[row.pact_relay_pending]
    const blocked =
      relayKind !== undefined &&
      db
        .prepare(
          `SELECT 1 FROM peer_reply_outbox
            WHERE pact_thread_id = ? AND relay_kind = ? AND state IN ('queued', 'sending')`
        )
        .get(row.id, relayKind) !== undefined
    if (blocked) {
      continue
    }
    try {
      if (row.pact_relay_pending === 'gap_notice') {
        drained += drainGapNotice(db, runtime, row.id)
        continue
      }
      if (row.pact_relay_pending === 'pause' || row.pact_relay_pending === 'resume') {
        drained += drainPausedOrResumed(db, runtime, row.id, row.pact_relay_pending)
        continue
      }
      const localPartyId = [row.pact_proposer_agent_id, row.pact_with_agent_id].find(
        (id): id is string => id !== null && !id.startsWith('remote:')
      )
      if (!localPartyId) {
        continue
      }
      const agentRow = db
        .prepare(`SELECT host_id, display_name FROM agents WHERE id = ?`)
        .get(localPartyId) as { host_id: string; display_name: string } | undefined
      if (!agentRow) {
        continue
      }
      // The most recent tombstoned predecessor sharing this pane's identity — the same
      // (host_id, display_name) lookup agent-thread-succession.ts's own predecessor scan uses.
      // A drain that runs after two undrained successions in a row will only tell the peer about
      // the LATEST one; §1.4(b) clause 3's idempotent, fail-closed lookup means a stale
      // `oldAgentId` is refused harmlessly on the peer rather than corrupting its mirror — flagged
      // as this drain's own known limit, not a silent one.
      const predecessor = db
        .prepare(
          `SELECT id FROM agents
           WHERE host_id = ? AND display_name = ? AND tombstoned_at IS NOT NULL AND id != ?
           ORDER BY tombstoned_at DESC LIMIT 1`
        )
        .get(agentRow.host_id, agentRow.display_name, localPartyId) as { id: string } | undefined
      if (!predecessor) {
        // Nothing to tell the peer (e.g. the flag survived a since-reverted state) — clear it
        // rather than looping on this thread forever.
        db.prepare(
          `UPDATE threads SET pact_relay_pending = NULL WHERE id = ? AND pact_relay_pending = 'rebind'`
        ).run(row.id)
        continue
      }
      const result = enqueueFederatedPactVerb(db, runtime, row.id, 'rebind_party', {
        actorAgentId: localPartyId,
        actorPaneKey: null,
        actorHostId: null,
        runId: 'host',
        rebind: { oldAgentId: predecessor.id }
      })
      if (result.outcome === 'enqueued') {
        db.prepare(
          `UPDATE threads SET pact_relay_pending = NULL WHERE id = ? AND pact_relay_pending = 'rebind'`
        ).run(row.id)
        drained += 1
      }
      // 'relay_pending': enqueueFederatedPactVerb already re-set the flag on its own cap fallback
      // — nothing to do. 'refused': the local message gate refused this host's own emitted
      // message; leave the flag set so the next tick retries.
    } catch (error) {
      // Isolate one thread's failure from the rest of the drain pass (mirrors reply-outbox-
      // pump.ts's own `Promise.allSettled` isolation for its claimed-item loop) — loud, never
      // silent: one audit row, the flag stays set for the next tick to retry.
      writeAgentAudit(db, {
        agentId: null,
        actorPaneKey: null,
        actorHostId: null,
        verb: 'pact_relay_pending_drain_failed',
        outcome: 'error',
        reasonCode:
          error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
      })
    }
  }
  return drained
}
