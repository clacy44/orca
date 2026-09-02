// Wire shape for `orchestration sent --id <message_id>` (S10 BUG 3) — shared so the CLI formatter
// and the main-process resolver agree on one contract instead of two structurally-hoped-equal ones.
// Why queued_awaiting_pane (S10-9 R4): distinct from 'queued' — an actual push attempt was
// made and withheld (busy pane, failed tui-idle probe, non-agent pane, no hydrated status),
// vs. 'queued' meaning no delivery attempt has happened yet.
// S10-15 verifier F4: 'relayed'/'relay_pending' cover a row addressed to a foreign peer
// (to_handle shaped `remote:<environmentId>:<agentId>`, S10-15 F1 R6's local mirror row) — that
// row is never "pointed" to a live pane on THIS host, so the pane-delivery states above never
// apply to it; reporting 'queued' forever for an accepted relay was the exact "queued into the
// void" symptom this slice exists to remove.
// S10-16 C5, R19.2: 'sending'/'refused'/'abandoned'/'cancelled' — the reply-outbox's own state
// union, surfaced on a row that has a `peer_reply_outbox` entry (orca-runtime.ts's relay branch).
export type OrchestrationDeliveryState =
  | 'queued'
  | 'queued_awaiting_pane'
  | 'pointed'
  | 'read'
  | 'relayed'
  | 'relay_pending'
  | 'sending'
  | 'refused'
  | 'abandoned'
  | 'cancelled'

export type OrchestrationMessageDelivery = {
  state: OrchestrationDeliveryState
  recipient: {
    state: 'connected' | 'disconnected' | 'unresolved'
    lastSeenAt: number | null
  }
  /** Set only when state is 'relayed' or 'relay_pending' — the saved-environment id parsed out
   *  of the row's `remote:<environmentId>:<agentId>` to_handle. */
  environment?: string
}

export type OrchestrationSentResult = {
  delivery: OrchestrationMessageDelivery
}
