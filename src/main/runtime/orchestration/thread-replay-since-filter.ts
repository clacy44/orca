import { OrchestrationError } from './orchestration-error'

/**
 * `orchestration thread --since` resumes by the monotonic `messages.sequence` column, not
 * `created_at` (S10-0 review minor): `created_at` has whole-second resolution, so two messages
 * sent in the same wall-clock second are indistinguishable by timestamp — a caller resuming from
 * either one's timestamp could re-see or silently drop the other. `sequence` is a strict total
 * order, so a cursor built from any prior reply's own `sequence` always resumes exactly.
 */
export function parseThreadSinceSequence(since: string): number {
  const value = Number(since)
  if (!Number.isInteger(value) || value < 0) {
    throw new OrchestrationError(
      'invalid_argument',
      `--since must be a message sequence number (a non-negative integer from a prior reply), got "${since}".`
    )
  }
  return value
}
