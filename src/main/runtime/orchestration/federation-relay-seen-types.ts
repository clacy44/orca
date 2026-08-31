// S10-4 ruling 2: durable per-item federation import outcome, keyed the same way this tree's
// federated-dispatch relay already keys sequence (dispatchId+sequence).
export type RelaySeenOutcome = 'imported' | 'refused' | 'duplicate'

export type RelaySeenRow = {
  dispatch_id: string
  sequence: number
  // federated_dispatches.relink_generation at record time — part of the PK alongside
  // dispatch_id+sequence (relink-generation fix: a relink zeroes the sequence cursor, so
  // sequence alone is not unique across a relink epoch for the same dispatch).
  generation: number
  message_id: string
  outcome: RelaySeenOutcome
  rule_ids: string | null
  created_at: string
}
