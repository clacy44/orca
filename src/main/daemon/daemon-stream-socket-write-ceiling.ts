/**
 * R117 FIX 1 (diag-r117-2026-09-08.md): a connected-but-slow client never drains
 * socket.writableLength, so past HELD_WRITE_THROUGH_TOTAL_CHARS the batcher's existing valve
 * writes through unconditionally and writableLength itself grows without bound — measured 998 MB
 * queued / +999 MB heapUsed / +1169 MB RSS from one such client, and the field cliff (two OOM
 * deaths at ~4 GB heap) followed in 17 min-2h45m depending on flood rate.
 *
 * Once the SOCKET ITSELF (not just the batcher's own queue) is this deep, stop writing to it for a
 * pass and forcibly trim the misbehaving session's own queued backlog instead of feeding it more.
 * dropOldestQueuedForSession no-ops when a session isn't actually over the keep-tail, so calling it
 * unconditionally for whichever entry is at the front only affects the session(s) actually
 * flooding this client.
 */
import {
  dropOldestQueuedForSession,
  type PendingStreamDataBatch,
  type StreamQueueEntry
} from './daemon-stream-keep-tail-drop'

export const SOCKET_WRITE_CEILING_BYTES = 64 * 1024 * 1024
// Same size as the background session's minimum keep-tail (daemon-stream-keep-tail-drop.ts
// BACKGROUND_SESSION_MIN_KEEP_TAIL_CHARS) — comfortably covers a full TUI repaint.
export const SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS = 64 * 1024

/** Returns true (and mutates batch/heldSessions/retained) when the socket is over ceiling and this
 *  entry must be held without writing this pass; false when the caller should proceed normally. */
export function holdForSocketWriteCeiling(
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry,
  writableLength: number,
  ceilingBytes: number,
  keepTailChars: number,
  salvageDroppedData: (dropped: string) => string,
  heldSessions: Set<string>,
  retained: PendingStreamDataBatch['queue']
): boolean {
  if (writableLength <= ceilingBytes) {
    return false
  }
  dropOldestQueuedForSession(batch, entry.sessionId, keepTailChars, salvageDroppedData)
  heldSessions.add(entry.sessionId)
  const heldEntry = batch.queue[0]
  if (heldEntry) {
    retained.push(heldEntry)
    batch.queue.shift()
  }
  return true
}
