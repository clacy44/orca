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
// [S10-21f b4, R147] 'queued_starved' — distinct from 'queued_awaiting_pane': the withheld
// record for this mailbox has crossed DELIVERY_STARVATION_BOUND_MS (orca-runtime.ts) — a Claude
// pane that has been busy, withheld, continuously, past the bound, with no idle/turn-boundary
// edge landing it. 'queued_awaiting_pane' covers every OTHER withheld disposition (ordinary
// pane_busy still inside the bound, no_live_pane, blocked_modal, etc.) unchanged.
export type OrchestrationDeliveryState =
  | 'queued'
  | 'queued_awaiting_pane'
  | 'queued_starved'
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
  /** R106: set only when state is 'relayed' and the row's peer_relayed_at is known (UTC,
   *  sqlite `datetime('now')`) — the CLI renders it verbatim rather than any live-presence
   *  claim, since a relay acceptance is not a delivery receipt. */
  relayedAt?: string
  /** [S10-21d D-R162 M-3] Set only on the reply-outbox 'delivered' branch (orca-runtime.ts):
   *  the far side itself accepted this reply, a resolvability claim stronger than the plain
   *  relay mirror's peer_relayed_at. Additive/optional — every other branch omits it. */
  deliveryConfirmed?: true
  /** [S10-21f b4, R147] Set only when state is 'queued_starved': how many whole minutes since
   *  the withheld record's firstAt, and how many withhold attempts (recordWithheldDelivery
   *  calls) have accumulated on it since. Lets the CLI render "for Nm (M attempts)" honestly
   *  instead of a fixed "10m+" that stays wrong for a mailbox starved much longer. */
  starvedMinutes?: number
  starvedAttempts?: number
}

export type OrchestrationSentResult = {
  delivery: OrchestrationMessageDelivery
}
