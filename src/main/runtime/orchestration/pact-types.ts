// S10-3 pact spec (SCHEMA v35). Split out of thread-directory-types.ts per that file's
// max-lines ratchet — same precedent as agent-directory-types.ts.
export const PACT_PAUSE_REASONS = [
  'counterpart_gone',
  'counterpart_left',
  'counterpart_quarantined',
  'thread_paused',
  'thread_closed',
  'operator'
] as const
export type PactPauseReason = (typeof PACT_PAUSE_REASONS)[number]

export const PACT_STEP_KINDS = [
  'propose',
  'accept',
  'decline',
  'step',
  'pause',
  'resume_request',
  'resume',
  'release'
] as const
export type PactStepKind = (typeof PACT_STEP_KINDS)[number]

// v35 ALTERs on `threads` (additive, ruling 1 — pact_state itself stays the v34 3-value CHECK;
// paused is the pact_paused_at flag, never a 4th pact_state value).
export type ThreadPactV35ColumnsRow = {
  pact_proposer_agent_id: string | null
  pact_steps_total: number | null
  pact_ordinal: number
  pact_paused_at: string | null
  pact_pause_reason: PactPauseReason | null
}

export type PactStepRow = {
  seq: number
  thread_id: string
  ordinal: number
  kind: PactStepKind
  actor_agent_id: string | null
  actor_pane_key: string | null
  actor_host_id: string | null
  message_id: string | null
  summary: string | null
  summary_sha256: string
  summary_purged_at: string | null
  turn_after_agent_id: string | null
  reason_code: string | null
  at: string
}

// Ruling 3's ledger read shape: skeleton always, summary only for the two participants / local
// operator, `[withheld - author quarantined]` for a quarantined author's step (read-time only,
// never stored), `[summary purged]` once purged. `pact --show`'s renderer (S10-3b, CLI series)
// prints these fields; this worktree only produces them.
export type PactLedgerEntry = {
  ordinal: number
  kind: PactStepKind
  actorAgentId: string | null
  actorDisplayName: string | null
  at: string
  summary: string | null
  summaryShaPrefix: string | null
  withheld: boolean
  purged: boolean
  reasonCode: string | null
}

export type PactLedgerResult = {
  entries: PactLedgerEntry[]
  omitted: { purged: number; withheld: number }
}
