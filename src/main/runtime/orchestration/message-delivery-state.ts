import type {
  OrchestrationDeliveryState,
  OrchestrationMessageDelivery
} from '../../../shared/orchestration-delivery-state'

/**
 * `orchestration send`'s receipt is about the sender's own mail, not the message it just sent
 * (S10 BUG 3). This derives a real delivery state from the columns/state the runtime already
 * maintains, for `orchestration sent --id <message_id>`.
 */
export type MessageDeliveryState = OrchestrationDeliveryState
export type MessageRecipientPresence = OrchestrationMessageDelivery['recipient']

// Why read first: `pointedMessageIdsByHandle` is pruned lazily on the NEXT push cycle for a
// handle, so a row already marked read can still linger in it — read must win regardless.
export function resolveMessageDeliveryState(
  message: { id: string; read: number },
  pointedIds: ReadonlySet<string> | undefined
): MessageDeliveryState {
  if (message.read !== 0) {
    return 'read'
  }
  return pointedIds?.has(message.id) ? 'pointed' : 'queued'
}

export function resolveMessageRecipientPresence(
  toHandle: string,
  resolveLeaf: (handle: string) => { connected: boolean; lastOutputAt: number | null } | null
): MessageRecipientPresence {
  const leaf = resolveLeaf(toHandle)
  if (!leaf) {
    return { state: 'unresolved', lastSeenAt: null }
  }
  return { state: leaf.connected ? 'connected' : 'disconnected', lastSeenAt: leaf.lastOutputAt }
}
