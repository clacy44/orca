// S10-2 durable thread row types (SCHEMA v34; extended at v35, S10-3 pact spec). Split out of
// types.ts to keep that file under the repo's max-lines ratchet, same precedent as
// agent-directory-types.ts.
import type { PactPauseReason } from './pact-types'
export type ThreadOrigin = 'peer' | 'question' | 'fanout' | 'legacy'
export type ThreadState = 'open' | 'paused' | 'closed'
export type ThreadPactState = 'proposed' | 'engaged' | 'released'

export type ThreadRow = {
  id: string
  subject: string
  created_by_agent_id: string | null
  origin: ThreadOrigin
  state: ThreadState
  sensitive: number
  created_at: string
  last_message_at: string | null
  last_message_id: string | null
  last_message_sequence: number
  message_count: number
  pact_with_agent_id: string | null
  pact_state: ThreadPactState | null
  pact_turn_agent_id: string | null
  pact_at: string | null
  // v35 (S10-3 pact spec) — additive, see pact-types.ts.
  pact_proposer_agent_id: string | null
  pact_steps_total: number | null
  pact_ordinal: number
  pact_paused_at: string | null
  pact_pause_reason: PactPauseReason | null
  purged_at: string | null
  purge_reason: string | null
  purged_by_agent_id: string | null
}

export type ThreadParticipantRole = 'owner' | 'member'
export type ThreadParticipantInviteState = 'pending' | 'accepted' | 'declined'

export type ThreadParticipantRow = {
  thread_id: string
  participant_key: string
  agent_id: string | null
  handle: string | null
  role: ThreadParticipantRole
  joined_at: string
  left_at: string | null
  invited_by_agent_id: string | null
  invite_state: ThreadParticipantInviteState | null
  last_read_sequence: number
}

// messages' additive S10-2 v34 columns (purge tombstone, soft-gate flags, per-thread cursor,
// pact-step discriminator); pre-v34 rows predate them all. Kept here, not types.ts, per that
// file's max-lines ratchet.
export type MessageV34ColumnsRow = {
  purged_at?: string | null
  purge_reason?: string | null
  purged_by_agent_id?: string | null
  gate_flags?: string | null
  thread_sequence?: number | null
  // payload_kind (pact-spec rev 7): dedicated pact-step discriminator column, distinct from the
  // JSON payload.kind namespace already used by runtime notifications. Callers can never set it
  // directly; only insertGatedMessage's hostPayloadKind option writes it.
  payload_kind?: string | null
}

export type GateRefusalRow = {
  seq: number
  actor_agent_id: string | null
  actor_pane_key: string | null
  actor_host_id: string | null
  verb: string
  rule_ids: string
  acknowledged: number
  body_sha256: string
  body_bytes: number
  subject_sha256: string
  at: string
}
