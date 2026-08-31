// Wire shape for `orchestration sent --id <message_id>` (S10 BUG 3) — shared so the CLI formatter
// and the main-process resolver agree on one contract instead of two structurally-hoped-equal ones.
// Why queued_awaiting_pane (S10-9 R4): distinct from 'queued' — an actual push attempt was
// made and withheld (busy pane, failed tui-idle probe, non-agent pane, no hydrated status),
// vs. 'queued' meaning no delivery attempt has happened yet.
export type OrchestrationDeliveryState = 'queued' | 'queued_awaiting_pane' | 'pointed' | 'read'

export type OrchestrationMessageDelivery = {
  state: OrchestrationDeliveryState
  recipient: {
    state: 'connected' | 'disconnected' | 'unresolved'
    lastSeenAt: number | null
  }
}

export type OrchestrationSentResult = {
  delivery: OrchestrationMessageDelivery
}
