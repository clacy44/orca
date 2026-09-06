// S10-16 R14.6: peer_reply_outbox row types. Split out of reply-outbox-store.ts (max-lines
// ratchet) when S10-21b B1 (v42 federated-pact columns) pushed that file over the limit.
export type ReplyOutboxState =
  | 'queued'
  | 'sending'
  | 'delivered'
  | 'refused'
  | 'abandoned'
  | 'cancelled'

export type ReplyOutboxRow = {
  id: string
  seq: number
  localMessageId: string
  linkDeviceId: string
  environmentId: string
  boundPairingRevision: number
  peerCredentialFp: string
  peerKeyFingerprint: string
  inReplyToMessageId: string
  peerAgentId: string
  peerThreadId: string | null
  localThreadId: string | null
  noticeRunId: string | null
  noticePaneKey: string | null
  payload: string
  byteCount: number
  state: ReplyOutboxState
  leaseExpiresAt: number | null
  attempts: number
  consecutiveFailures: number
  holdCount: number
  firstHeldAt: number | null
  lastAttemptAt: number | null
  nextAttemptAfter: number | null
  lastErrorCode: string | null
  lastError: string | null
  peerMessageId: string | null
  peerReplyThreadId: string | null
  createdAt: number
  settledAt: number | null
  notifiedAt: number | null
  lastNotifiedCondition: string | null
  lastNotifiedAt: number | null
  // v42 (S10-21b B1, federated pacts) — additive; optional, fromSqlRow isn't extended to
  // populate these until B4 (outbox generalisation).
  relayKind?: string
  pactThreadId?: string | null
  pactSeq?: number | null
  pactEra?: number | null
  pactTurnAfter?: string | null
  pactState?: string | null
  pactFlightToken?: number | null
}

export type ReplyOutboxSqlRow = {
  id: string
  seq: number
  local_message_id: string
  link_device_id: string
  environment_id: string
  bound_pairing_revision: number
  peer_credential_fp: string
  peer_key_fingerprint: string
  in_reply_to_message_id: string
  peer_agent_id: string
  peer_thread_id: string | null
  local_thread_id: string | null
  notice_run_id: string | null
  notice_pane_key: string | null
  payload: string
  byte_count: number
  state: ReplyOutboxState
  lease_expires_at: number | null
  attempts: number
  consecutive_failures: number
  hold_count: number
  first_held_at: number | null
  last_attempt_at: number | null
  next_attempt_after: number | null
  last_error_code: string | null
  last_error: string | null
  peer_message_id: string | null
  peer_reply_thread_id: string | null
  created_at: number
  settled_at: number | null
  notified_at: number | null
  last_notified_condition: string | null
  last_notified_at: number | null
  // v42 (S10-21b B1, federated pacts) — additive, optional (see ReplyOutboxRow above).
  relay_kind?: string
  pact_thread_id?: string | null
  pact_seq?: number | null
  pact_era?: number | null
  pact_turn_after?: string | null
  pact_state?: string | null
  pact_flight_token?: number | null
}
