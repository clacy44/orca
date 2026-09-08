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
// D-R164 L3: a full TUI repaint is ~cols×rows×SGR ≈ 100KB (daemon-stream-keep-tail-drop.ts:45-50);
// the background session's own 64KB MIN_KEEP_TAIL_CHARS is that comment's own squeezed floor
// (only reached once many sessions are backgrounded), not a repaint-covering size on its own.
export const SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS = 128 * 1024

// D-R164 L1: control entries bypassed the ceiling entirely; hold the rest too — except 'exit'
// (nothing else will ever deliver it once the session is gone) and 'dataGap' (the ceiling's own
// loud-degradation signal — coalesced to one entry per session, so it's already bounded, and must
// reach the client promptly, not wait behind the very flood it's reporting).
export function shouldHoldControlEntryOverCeiling(
  eventName: string,
  writableLength: number,
  ceilingBytes: number
): boolean {
  return eventName !== 'exit' && eventName !== 'dataGap' && writableLength > ceilingBytes
}

export type SocketWriteCeilingHold = (
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry,
  writableLength: number,
  heldSessions: Set<string>,
  retained: PendingStreamDataBatch['queue']
) => boolean

/** Binds the per-instance salvage/ceiling/keep-tail so the batcher's flush() loop calls a
 *  5-arg function per entry instead of repeating its own fixed config at every call site.
 *  ceilingBytes/keepTailChars default to the constants above; overridable for tests only. */
export function createSocketWriteCeilingHold(
  salvageDroppedData: (dropped: string) => string,
  ceilingBytes: number = SOCKET_WRITE_CEILING_BYTES,
  keepTailChars: number = SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS
): SocketWriteCeilingHold {
  return (batch, entry, writableLength, heldSessions, retained) => {
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
}
