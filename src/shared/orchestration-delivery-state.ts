// Wire shape for `orchestration sent --id <message_id>` (S10 BUG 3) — shared so the CLI formatter
// and the main-process resolver agree on one contract instead of two structurally-hoped-equal ones.
export type OrchestrationDeliveryState = 'queued' | 'pointed' | 'read'

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
