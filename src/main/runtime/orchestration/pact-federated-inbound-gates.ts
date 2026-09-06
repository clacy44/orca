// S10-21b B8 (design §2.4, §4.2 gates 6-13) — inbound pact-verb GATES: grammar, dedupe,
// route/thread, era, party, matrix. Split from pact-federated-inbound-apply.ts (gate 14 + apply)
// per the max-lines ratchet; gate 6 runs in the RPC handler. Gate 13: the design groups
// accept/decline/step/pause/resume under one "requireEngaged" heading, but accept/decline
// answer a still-`proposed` pact — applies each verb's OWN precondition (matching
// pact-propose-accept.ts/pact-lifecycle.ts), a reading flagged in this commit's RETURN.
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { renderFederatedPartyKey } from './pact-federated-identity'
import type { PactStepKind } from './pact-types'
import { isHostScopedId, isHostThreadId, requireHostThreadId } from './orchestration-id-grammar'
import type { ThreadRow } from './types'

// §4.6(a) — first enforced at this commit's own `pact_applied_ids` write; commit 14 imports it.
export const PACT_STEPS_PER_PACT_CAP = 4_096

// The eleven wire verbs (§2.4).
export type InboundPactVerb =
  | 'propose'
  | 'accept'
  | 'decline'
  | 'step'
  | 'pause'
  | 'resume'
  | 'release'
  | 'rebind_party'
  | 'resync'
  | 'resync_request'
  | 'gap_notice'

export const LEDGER_VERB_KIND: Partial<Record<InboundPactVerb, PactStepKind>> = {
  propose: 'propose',
  accept: 'accept',
  decline: 'decline',
  step: 'step',
  pause: 'pause',
  resume: 'resume',
  release: 'release'
}

export const NO_LEDGER_VERBS: ReadonlySet<InboundPactVerb> = new Set([
  'resync',
  'resync_request',
  'rebind_party',
  'gap_notice'
])

// B13 wires `rebind_party` for real (pact-federated-rebind.ts) — the set is now empty and the
// mechanism it gated is retired (nothing else was ever added to it).

export type InboundPactEnvelope = {
  verb: InboundPactVerb
  seq: number
  era: number
  stepsTotal?: number | null
  ordinal?: number
  reasonCode?: string
  rebind?: { oldAgentId: string }
  resyncRequest?: { nonce: string }
  resync?: {
    nonce: string
    localSeq: number
    ordinal: number
    state: 'proposed' | 'engaged' | 'released'
    turnHeldBySender: boolean
    pauseEpoch: number
    senderReleased: boolean
  }
}

export type ApplyInboundPactVerbArgs = {
  pairedDeviceId: string
  senderAgentId: string
  senderEnvironmentId: string
  messageId: string
  peerThreadId: string | null
  toAgentId: string
  body: string | undefined
  pact: InboundPactEnvelope
}

// A-F9/B-F7: exported so era-adoption's ceiling check (pact-federated-era.ts) shares this exact
// grammar bound rather than a second literal.
export const SAFE_INT_MAX = 2 ** 31 - 1

function requirePactSafeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_INT_MAX) {
    throw new OrchestrationError(
      'invalid_argument',
      `The relayed pact ${field} is not a valid non-negative bounded integer.`,
      { reasonCode: 'malformed_relay_id' }
    )
  }
  return value
}

// Opaque token grammar (§1.3, not the seq/era/ordinal Number.isSafeInteger shape): bounded,
// non-empty, never substring-matched (zod already caps it at 64 chars).
function requirePactNonce(value: string, field: string): string {
  if (value.length === 0 || !/^[0-9a-zA-Z_-]+$/.test(value)) {
    throw new OrchestrationError(
      'invalid_argument',
      `The relayed pact ${field} is not a valid nonce.`,
      { reasonCode: 'malformed_relay_id' }
    )
  }
  return value
}

export function renderedSenderKey(args: ApplyInboundPactVerbArgs): string {
  return renderFederatedPartyKey({
    linkDeviceId: args.pairedDeviceId,
    remoteAgentId: args.senderAgentId
  })
}

function isPactParty(thread: ThreadRow, key: string): boolean {
  return thread.pact_proposer_agent_id === key || thread.pact_with_agent_id === key
}

export function otherLocalParty(thread: ThreadRow, senderKey: string): string | null {
  const other =
    thread.pact_proposer_agent_id === senderKey
      ? thread.pact_with_agent_id
      : thread.pact_proposer_agent_id
  return other && !other.startsWith('remote:') ? other : null
}

// Gate 7 — id grammar on every pact field this envelope carries.
export function runPactGrammarGate(args: ApplyInboundPactVerbArgs): string {
  const { pact } = args
  requirePactSafeInt(pact.seq, 'seq')
  requirePactSafeInt(pact.era, 'era')
  // N3: a propose's seq must be EXACTLY 1 (A-F8) — checked here, BEFORE thread resolution and
  // resolveCrossProposeOutcome's auto-decline, so a malformed propose can never destroy this
  // host's own outstanding proposal before being refused. propose-apply.ts's later check stays
  // as defence.
  if (pact.verb === 'propose' && pact.seq !== 1) {
    throw new OrchestrationError(
      'pact_out_of_order',
      `Refused: a propose's seq must be 1 (relayed seq ${pact.seq}).`
    )
  }
  if (pact.ordinal !== undefined) {
    requirePactSafeInt(pact.ordinal, 'ordinal')
  }
  if (pact.rebind && !isHostScopedId(pact.rebind.oldAgentId, ['agt'])) {
    throw new OrchestrationError(
      'invalid_argument',
      'The relayed pact rebind.oldAgentId is not a valid agent id.',
      { reasonCode: 'malformed_relay_id' }
    )
  }
  if (pact.resyncRequest) {
    requirePactNonce(pact.resyncRequest.nonce, 'resyncRequest.nonce')
  }
  if (pact.resync) {
    requirePactNonce(pact.resync.nonce, 'resync.nonce')
    requirePactSafeInt(pact.resync.localSeq, 'resync.localSeq')
    requirePactSafeInt(pact.resync.ordinal, 'resync.ordinal')
    requirePactSafeInt(pact.resync.pauseEpoch, 'resync.pauseEpoch')
  }
  if (args.peerThreadId === null || !isHostThreadId(args.peerThreadId)) {
    // Always present for a pact envelope (required here, optional at the general mail site).
    requireHostThreadId(args.peerThreadId, 'pact thread id')
  }
  return args.peerThreadId as string
}

export type PactThreadResolution =
  | { mode: 'propose'; thread: ThreadRow }
  | { mode: 'apply'; thread: ThreadRow }
  | { mode: 'release_noop' }

// Gate 12's propose limb (A-F15, N2): mirrors the LOCAL rule (pact-shared.ts's
// requireSensitiveMembership) — participation is required only on a SENSITIVE thread; a
// non-sensitive thread may name a non-participant, exactly as a local proposer may.
function requirePactProposeParticipant(
  db: Database.Database,
  thread: ThreadRow,
  senderKey: string
): void {
  if (thread.sensitive !== 1) {
    return
  }
  const row = db
    .prepare(
      `SELECT 1 FROM thread_participants WHERE thread_id = ? AND participant_key = ? AND left_at IS NULL`
    )
    .get(thread.id, senderKey)
  if (!row) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: ${senderKey} is not a participant on ${thread.id}.`
    )
  }
}

// Gate 10 (+ the propose limb's gate 12 participant check, A-F15) — thread resolution only (gate
// 9/route runs in the RPC handler itself, which already holds pairedDeviceId/runtime). Era/party/
// matrix (gates 11-13) are `runPactPartyAndMatrixGates`, below — split so the applied-ids dedupe
// gate (8b) can run in between, scoped to the thread this function resolves (A-F17: an inbound
// `release` on an unmapped thread is an accepted idempotent no-op, not a terminal refusal).
export function resolvePactThread(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs,
  peerThreadId: string
): PactThreadResolution {
  const { pact } = args
  const senderKey = renderedSenderKey(args)

  const threadRow = db
    .prepare(
      `SELECT * FROM threads
        WHERE pact_peer_link_device_id = ? AND pact_peer_thread_id = ? AND purged_at IS NULL`
    )
    .get(args.pairedDeviceId, peerThreadId) as ThreadRow | undefined

  if (pact.verb === 'propose') {
    // First-ever propose: resolve via the general foreign-thread mapping (the two hosts
    // already share an ordinary mail thread before a pact can be proposed on it).
    const mapped =
      threadRow ??
      (db
        .prepare(
          `SELECT t.* FROM threads t
             JOIN messages m ON m.thread_id = t.id
            WHERE m.peer_link_device_id = ? AND m.peer_thread_id = ? AND t.purged_at IS NULL
            ORDER BY m.sequence DESC LIMIT 1`
        )
        .get(args.pairedDeviceId, peerThreadId) as ThreadRow | undefined)
    if (!mapped) {
      throw new OrchestrationError(
        'not_found',
        `No local thread corresponds to the peer's thread ${peerThreadId}.`
      )
    }
    requirePactProposeParticipant(db, mapped, senderKey)
    return { mode: 'propose', thread: mapped }
  }

  if (!threadRow) {
    if (pact.verb === 'release') {
      // §2.9 — a release on a thread this host has no record of is an accepted no-op, not a
      // terminal refusal (idempotent: the peer may have already purged/never mapped it).
      return { mode: 'release_noop' }
    }
    throw new OrchestrationError(
      'pact_no_pact',
      `Refused: no pact thread corresponds to the peer's thread ${peerThreadId}.`
    )
  }
  return { mode: 'apply', thread: threadRow }
}

// N5: 'ok' is the ordinary throws-or-passes shape; 'resume_noop' signals an inbound `resume`
// against a peer this host never recorded as paused — an accepted idempotent no-op (mirrors
// A-F17's release_noop), never the transport-shaped `pact_not_paused`.
export type MatrixGateResult = { outcome: 'ok' } | { outcome: 'resume_noop' }

// Gates 11-13 — era, party, matrix, applied against OUR columns. Throws on refusal.
export function runPactPartyAndMatrixGates(
  args: ApplyInboundPactVerbArgs,
  thread: ThreadRow
): MatrixGateResult {
  const { pact } = args
  const senderKey = renderedSenderKey(args)

  // Gate 11 — era equality (every verb but `propose`); mismatch is terminal.
  if (thread.pact_era !== pact.era) {
    throw new OrchestrationError(
      'pact_era_mismatch',
      `Refused: this pact's era has moved (era ${thread.pact_era}, relayed era ${pact.era}).`
    )
  }

  // Gate 12 — party: sender must already be a pact party, re-read fresh each call. B13:
  // `rebind_party` is exempt — its sender authenticates as the NEW identity, which by
  // definition is not yet the recorded party; that check is the six-clause apply's own clause 5
  // (`remote:<link>:<rebind.oldAgentId>` must be the party), pact-federated-rebind.ts.
  if (pact.verb !== 'rebind_party' && !isPactParty(thread, senderKey)) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: ${senderKey} is not a party to the pact on ${thread.id}.`
    )
  }

  // Gate 13 — the per-verb applicability matrix (§4.2), applied against OUR columns.
  // B-F5/A-F5: a turn-consuming verb arriving while OUR own emit is mid-settle is retryable
  // (`pact_settling`), never the transport-shaped `not_a_participant` the holder check below
  // would otherwise raise — checked first, ahead of every other gate-13 precondition.
  if (thread.pact_turn_in_flight_at !== null && (pact.verb === 'step' || pact.verb === 'accept')) {
    throw new OrchestrationError(
      'pact_settling',
      `Refused: ${thread.id}'s prior turn is still settling; retry shortly.`
    )
  }

  if (pact.verb === 'accept' || pact.verb === 'decline') {
    if (thread.pact_state !== 'proposed' || thread.pact_with_agent_id !== senderKey) {
      throw new OrchestrationError(
        'pact_not_engaged',
        `Refused: ${thread.id} has no pending proposal to ${senderKey}.`
      )
    }
    // B-F13/§4.2: accept/decline regain the not-paused check — a local pause for containment
    // must block the peer from moving proposed -> engaged (or declining) underneath it.
    if (thread.pact_paused_at !== null) {
      throw new OrchestrationError('pact_paused', `Refused: this pact is paused.`)
    }
  } else if (pact.verb === 'step' || pact.verb === 'pause') {
    if (thread.pact_state !== 'engaged') {
      throw new OrchestrationError('pact_not_engaged', `Refused: ${thread.id} has no engaged pact.`)
    }
    if (thread.pact_paused_at !== null || thread.pact_peer_paused_at !== null) {
      throw new OrchestrationError('pact_paused', `Refused: this pact is paused.`)
    }
    if (pact.verb === 'step' && thread.pact_turn_agent_id !== senderKey) {
      throw new OrchestrationError(
        'not_a_participant',
        `Refused: ${senderKey} does not hold the turn on ${thread.id}.`
      )
    }
  } else if (pact.verb === 'resume') {
    // B-F3: an inbound `resume` clears the PEER's pause as WE recorded it — gated on
    // `pact_peer_paused_at` (their pause) only, NEVER on `effectivePaused`/our own pause; our
    // own pause is lifted only by our own local `--resume`, never by a relayed one.
    if (thread.pact_state !== 'engaged') {
      throw new OrchestrationError('pact_not_engaged', `Refused: ${thread.id} has no engaged pact.`)
    }
    if (thread.pact_peer_paused_at === null) {
      // N5: idempotent no-op, not a refusal — `pact_not_paused` had no classifier entry
      // (reply-outbox-pump-disposition.ts), so a duplicate/late resume fell through to the
      // transport-shaped bumpFailure branch and degraded the link's failure threshold.
      return { outcome: 'resume_noop' }
    }
  }
  // `release`/`gap_notice`/`resync`/`resync_request`/`rebind_party`: applicable from any state,
  // while paused — no gate, per §4.2/§2.5.
  return { outcome: 'ok' }
}
