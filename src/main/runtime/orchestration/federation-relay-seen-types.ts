// S10-4 ruling 2: durable per-item federation import outcome, keyed the same way this tree's
// federated-dispatch relay already keys sequence (dispatchId+sequence).
export type RelaySeenOutcome = 'imported' | 'refused' | 'duplicate'

export type RelaySeenRow = {
  dispatch_id: string
  sequence: number
  message_id: string
  outcome: RelaySeenOutcome
  rule_ids: string | null
  created_at: string
}
