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

// Real semantics land with B9 (resync/resync_request/gap_notice's gap case)/B13 (rebind_party) —
// recognised here but refused loudly rather than mis-applied.
export const NOT_YET_IMPLEMENTED_VERBS: ReadonlySet<InboundPactVerb> = new Set([
  'rebind_party',
  'resync',
  'resync_request'
])

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

const SAFE_INT_MAX = 2 ** 31 - 1

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

export type PactDedupeResult = { outcome: 'fresh' } | { outcome: 'duplicate'; threadId: string }

// Gate 8 — message dedupe, verb-aware, against BOTH `pact_steps` (ledger verbs) and
// `pact_applied_ids` (the four no-ledger verbs) — §2.5's "already in the ledger" leg.
export function runPactDedupeGate(
  db: Database.Database,
  args: ApplyInboundPactVerbArgs,
  peerThreadId: string
): PactDedupeResult {
  const existingStep = db
    .prepare(
      `SELECT relay_seq, kind FROM pact_steps WHERE message_id = ? AND thread_id IN
         (SELECT id FROM threads WHERE pact_peer_link_device_id = ? AND pact_peer_agent_id = ?)`
    )
    .get(args.messageId, args.pairedDeviceId, args.senderAgentId) as
    | { relay_seq: number | null; kind: string }
    | undefined
  const existingApplied = db
    .prepare(`SELECT verb FROM pact_applied_ids WHERE message_id = ?`)
    .get(args.messageId) as { verb: string } | undefined
  if (existingStep === undefined && existingApplied === undefined) {
    return { outcome: 'fresh' }
  }
  const mismatched =
    (existingApplied !== undefined && existingApplied.verb !== args.pact.verb) ||
    (existingStep !== undefined &&
      (existingStep.kind !== args.pact.verb ||
        (existingStep.relay_seq !== null && existingStep.relay_seq !== args.pact.seq)))
  if (mismatched) {
    throw new OrchestrationError(
      'request_mismatch',
      `Relayed pact message ${args.messageId} conflicts with an existing pact record on this host.`
    )
  }
  // A genuine duplicate replay — return the stored receipt, apply nothing (§2.5, audited under §2.9).
  const priorThread = db
    .prepare(`SELECT thread_id FROM pact_steps WHERE message_id = ? LIMIT 1`)
    .get(args.messageId) as { thread_id: string } | undefined
  return { outcome: 'duplicate', threadId: priorThread?.thread_id ?? peerThreadId }
}

export type PactThreadResolution = { mode: 'propose' | 'apply'; thread: ThreadRow }

// Gates 10-13 — thread, era, party, matrix (gate 9/route runs in the RPC handler itself, which
// already holds pairedDeviceId/runtime).
export function resolvePactThreadAndGates(
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
    return { mode: 'propose', thread: mapped }
  }

  if (!threadRow) {
    throw new OrchestrationError(
      'pact_no_pact',
      `Refused: no pact thread corresponds to the peer's thread ${peerThreadId}.`
    )
  }
  const thread = threadRow

  // Gate 11 — era equality (every verb but `propose`); mismatch is terminal.
  if (thread.pact_era !== pact.era) {
    throw new OrchestrationError(
      'pact_era_mismatch',
      `Refused: this pact's era has moved (era ${thread.pact_era}, relayed era ${pact.era}).`
    )
  }

  // Gate 12 — party: sender must already be a pact party, re-read fresh each call.
  if (!isPactParty(thread, senderKey)) {
    throw new OrchestrationError(
      'not_a_participant',
      `Refused: ${senderKey} is not a party to the pact on ${thread.id}.`
    )
  }

  // Gate 13 — the per-verb applicability matrix (§4.2), applied against OUR columns.
  const effectivePaused = thread.pact_paused_at !== null || thread.pact_peer_paused_at !== null
  const appliesWhilePaused =
    pact.verb === 'release' ||
    pact.verb === 'resync' ||
    pact.verb === 'resync_request' ||
    pact.verb === 'gap_notice' ||
    pact.verb === 'rebind_party'

  if (NOT_YET_IMPLEMENTED_VERBS.has(pact.verb)) {
    throw new OrchestrationError(
      'pact_repair_not_yet_available',
      `Refused: ${pact.verb} is recognised but this host does not yet apply it (S10-21b commit 9/13).`
    )
  }

  if (pact.verb === 'accept' || pact.verb === 'decline') {
    if (thread.pact_state !== 'proposed' || thread.pact_with_agent_id !== senderKey) {
      throw new OrchestrationError(
        'pact_not_engaged',
        `Refused: ${thread.id} has no pending proposal to ${senderKey}.`
      )
    }
  } else if (pact.verb === 'step' || pact.verb === 'pause' || pact.verb === 'resume') {
    if (thread.pact_state !== 'engaged') {
      throw new OrchestrationError('pact_not_engaged', `Refused: ${thread.id} has no engaged pact.`)
    }
    if (!appliesWhilePaused && effectivePaused) {
      throw new OrchestrationError('pact_paused', `Refused: this pact is paused.`)
    }
    if (pact.verb === 'step' && thread.pact_turn_agent_id !== senderKey) {
      throw new OrchestrationError(
        'not_a_participant',
        `Refused: ${senderKey} does not hold the turn on ${thread.id}.`
      )
    }
  }
  // `release`/`gap_notice`: applicable from any state, while paused — no gate, per §4.2/§2.5.
  return { mode: 'apply', thread }
}
