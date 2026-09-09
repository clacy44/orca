/**
 * Shallow-socket echo protection: the stream is one FIFO, so a deep buffer buries a visible
 * pane's echo behind other panes' bulk. Bulk stops here and is held (flushSession can jump it),
 * bounding echo latency — separate from and shallower than the hard socket-write ceiling
 * (daemon-stream-socket-write-ceiling.ts), which exists to bound memory, not latency.
 */
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'

// 128KB stays above the socket's ~16KB highWaterMark so a held state implies a false write() and
// thus a guaranteed 'drain' wake-up. D-R167 M-2: daemon-server.ts's pacer does NOT reuse this
// value — it imports its own PRODUCER_PAUSE_HIGH/LOW_WATERMARK_BYTES from
// daemon-stream-data-batcher.ts instead (see that file's comment for the composed reality: this
// gate plus BULK_WRITE_SLICE_CHARS is what makes the pacer's HIGH watermark unreachable). Not
// exported — no reader outside this file.
const SHALLOW_SOCKET_WRITE_GATE_BYTES =
  process.env.ORCA_DAEMON_SHALLOW_SOCKET_GATE === '0' ? Number.POSITIVE_INFINITY : 128 * 1024
// Safety valve: past this, write through — bounded daemon memory beats bounded echo latency in the
// extreme. Must sit FAR above the pacer's pause watermark + overshoot (~5MB) or an engaged valve
// buries interactive echo behind the whole backlog.
const HELD_WRITE_THROUGH_TOTAL_CHARS = 32 * 1024 * 1024
// A few-KB session (echo, redraws, query replies) is never the flood, so it must not wait FIFO
// behind others' megabytes; backstops the 100ms interactive fast-path, which misses under
// event-loop load.
const SMALL_SESSION_HOLD_BYPASS_CHARS = 4 * 1024

/** True if this entry should be held rather than written this pass. Logs once per call when the
 *  memory valve (not the latency gate) is what let a flooding session's bulk through instead. */
export function shouldHoldForShallowSocket(
  writableLength: number,
  queuedChars: number,
  sessionHeldChars: number,
  sessionAlreadyHeld: boolean
): boolean {
  if (writableLength < SHALLOW_SOCKET_WRITE_GATE_BYTES) {
    return false
  }
  if (queuedChars <= HELD_WRITE_THROUGH_TOTAL_CHARS) {
    return sessionAlreadyHeld || sessionHeldChars > SMALL_SESSION_HOLD_BYPASS_CHARS
  }
  recordDaemonStreamBacklogEvent('heldWriteThrough', {
    heldChars: queuedChars,
    socketBufferedBytes: writableLength
  })
  return false
}
