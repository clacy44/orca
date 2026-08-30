import { OrchestrationError } from './orchestration-error'

/**
 * `orchestration thread --since` resumes by the monotonic `messages.sequence` column, not
 * `created_at` (S10-0 review minor): `created_at` has whole-second resolution, so two messages
 * sent in the same wall-clock second are indistinguishable by timestamp — a caller resuming from
 * either one's timestamp could re-see or silently drop the other. `sequence` is a strict total
 * order, so a cursor built from any prior reply's own `sequence` always resumes exactly.
 *
 * Remote wire compatibility (AGENTS.md remote-wire-compatibility): a pre-migration client or host
 * prints and resumes with an ISO `created_at` cursor. Silently reinterpreting that string as a
 * `sequence` (or vice versa) would either throw on an old client's own cursor or, worse, filter
 * nothing at all — every `created_at` string compares greater than a small integer, so an old
 * host reading a new `sequence` cursor would return an empty replay with no error. Both cursor
 * shapes are therefore accepted for one release; `db.getThreadMessages` branches on `kind`.
 */
export type ThreadSinceCursor =
  | { kind: 'sequence'; value: number }
  | { kind: 'timestamp'; value: string }

// The whole-second, space-or-'T'-separated shape `datetime('now')` emits and pre-S10-1 hosts
// printed back as a resumable cursor (offset/zone suffix optional).
const TIMESTAMP_CURSOR_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/

export function parseThreadSinceCursor(since: string): ThreadSinceCursor {
  if (/^\d+$/.test(since)) {
    return { kind: 'sequence', value: Number(since) }
  }
  if (TIMESTAMP_CURSOR_SHAPE.test(since)) {
    return { kind: 'timestamp', value: since }
  }
  throw new OrchestrationError(
    'invalid_argument',
    `--since must be a message sequence number (from a prior reply) or an ISO timestamp (from a pre-migration host), got "${since}".`
  )
}
