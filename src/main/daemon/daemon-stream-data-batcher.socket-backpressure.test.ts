// R117 FIX 1: a connected-but-slow client never drains socket.writableLength. This asserts the
// batcher stops writing once the socket crosses the hard ceiling instead of feeding it further
// (the pre-fix behavior: HELD_WRITE_THROUGH_TOTAL_CHARS writes through unconditionally past 32MB
// queued, regardless of writableLength — see diag-r117-2026-09-08.md).
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import {
  DaemonStreamDataBatcher,
  BULK_WRITE_SLICE_CHARS,
  PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
} from './daemon-stream-data-batcher'
import { SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS } from './daemon-stream-socket-write-ceiling'

// 128MB/16MB instead of the field-measured 512MB/64MB (diag-r117-2026-09-08.md) — same ratio,
// lighter for CI/shared-box runs; the mechanism under test doesn't depend on the absolute size.
const CAP = 16 * 1024 * 1024
const TOTAL_PUSHED = 128 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024

function createNeverDrainingSocket(): Socket & { write: ReturnType<typeof vi.fn> } {
  const socket = {
    destroyed: false,
    writableLength: 0,
    write: vi.fn()
  } as unknown as Socket & { write: ReturnType<typeof vi.fn>; writableLength: number }
  // Simulates a stalled peer: writableLength only grows, never drains, and the write callback
  // (which would normally fire on kernel flush) is never invoked.
  socket.write.mockImplementation((line: string) => {
    socket.writableLength += Buffer.byteLength(String(line))
    return true
  })
  return socket
}

function distinctChunk(index: number): string {
  // Distinct content per chunk (not a repeated character) so V8 can't alias/rope the pushed data
  // away from what it actually costs to hold — mirrors the diagnosis's "Test trap" note.
  return `${index}`.padStart(8, '0') + 'x'.repeat(CHUNK_BYTES - 8)
}

describe('DaemonStreamDataBatcher socket-write ceiling (R117 FIX 1)', () => {
  it('bounds queuedCharsForClient and socket.writableLength once the socket crosses the ceiling, and emits one dataGap', () => {
    const streamSocket = createNeverDrainingSocket()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
      socketWriteCeilingBytes: CAP,
      isSessionDroppable: () => false
    })

    const chunkCount = TOTAL_PUSHED / CHUNK_BYTES
    for (let i = 0; i < chunkCount; i++) {
      batcher.enqueue('client-1', 'session-flood', distinctChunk(i))
      // Flush periodically (not just once at the end) so the ceiling check actually engages while
      // more data is still arriving, matching the sustained-flood field scenario.
      if (i % 256 === 0) {
        batcher.flush('client-1')
      }
    }
    batcher.flush('client-1')

    // D-R164 M3: the real per-client bound past the ceiling is keep-tail × sessions (one
    // flooding session here) + one already-in-flight slice — not the ceiling override itself,
    // which is a socket-writableLength cap, not a queued-chars cap.
    expect(batcher.queuedCharsForClient('client-1')).toBeLessThanOrEqual(
      SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS + BULK_WRITE_SLICE_CHARS
    )
    // The ceiling is checked before each write, so one already-in-flight slice (at most
    // BULK_WRITE_SLICE_CHARS = 64KB) can land after writableLength first crosses it — bounded
    // overshoot, not the unbounded growth asserted absent in the next test.
    expect(streamSocket.writableLength).toBeLessThanOrEqual(CAP + BULK_WRITE_SLICE_CHARS)

    const dataGapWrites = streamSocket.write.mock.calls.filter(([line]) =>
      String(line).includes('"event":"dataGap"')
    )
    expect(dataGapWrites.length).toBeGreaterThanOrEqual(1)
  })

  it('WITHOUT a ceiling override (Number.POSITIVE_INFINITY), the same flood is unbounded — proves the assertions above are load-bearing', () => {
    const streamSocket = createNeverDrainingSocket()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
      socketWriteCeilingBytes: Number.POSITIVE_INFINITY,
      isSessionDroppable: () => false
    })

    const chunkCount = TOTAL_PUSHED / CHUNK_BYTES
    for (let i = 0; i < chunkCount; i++) {
      batcher.enqueue('client-1', 'session-flood', distinctChunk(i))
      if (i % 256 === 0) {
        batcher.flush('client-1')
      }
    }
    batcher.flush('client-1')

    // With the ceiling disabled, the HELD_WRITE_THROUGH valve (unchanged pre-existing behavior)
    // writes the flood through once queued chars exceed its 32MB threshold — this is exactly what
    // exceeds CAP on the pre-FIX-1 code path (no ceiling check existed at all).
    expect(streamSocket.writableLength).toBeGreaterThan(CAP)
  })

  // D-R164 M3: FIX 1 (this ceiling) and FIX 3 (the socket-depth pacer, daemon-server.ts) were only
  // ever tested in isolation — the composition (both wired at once, as production always runs
  // them) was unproven.
  describe('composed with the socket-depth pacer (onAfterSocketWrite wired, R117 FIX 1 + FIX 3)', () => {
    it('the pacer engages (pause) well before the ceiling under a slow drain', () => {
      const streamSocket = createNeverDrainingSocket()
      const pauseCalledAtWritableLength: number[] = []
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
        socketWriteCeilingBytes: CAP,
        isSessionDroppable: () => false,
        onAfterSocketWrite: () => {
          if (streamSocket.writableLength >= PRODUCER_PAUSE_HIGH_WATERMARK_BYTES) {
            pauseCalledAtWritableLength.push(streamSocket.writableLength)
          }
        }
      })

      const chunkCount = TOTAL_PUSHED / CHUNK_BYTES
      let dataGapSeen = false
      for (let i = 0; i < chunkCount && !dataGapSeen; i++) {
        batcher.enqueue('client-1', 'session-flood', distinctChunk(i))
        if (i % 256 === 0) {
          batcher.flush('client-1')
        }
        dataGapSeen = streamSocket.write.mock.calls.some(([line]) =>
          String(line).includes('"event":"dataGap"')
        )
      }

      // The pacer's HIGH watermark (256KB) sits far below the ceiling (CAP=16MB): it must have
      // fired, and at a writableLength far short of the ceiling ever being reached.
      expect(pauseCalledAtWritableLength.length).toBeGreaterThan(0)
      expect(pauseCalledAtWritableLength[0]).toBeLessThan(CAP)
    })

    it('the ceiling still bounds the queue when the pacer is wired and the producer ignores every pause', () => {
      const streamSocket = createNeverDrainingSocket()
      // Simulates a producer that never actually honors pauseProducer (worst case for FIX 1):
      // the enqueue loop below keeps pushing regardless of what onAfterSocketWrite reports.
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
        socketWriteCeilingBytes: CAP,
        isSessionDroppable: () => false,
        onAfterSocketWrite: () => {}
      })

      const chunkCount = TOTAL_PUSHED / CHUNK_BYTES
      for (let i = 0; i < chunkCount; i++) {
        batcher.enqueue('client-1', 'session-flood', distinctChunk(i))
        if (i % 256 === 0) {
          batcher.flush('client-1')
        }
      }
      batcher.flush('client-1')

      expect(batcher.queuedCharsForClient('client-1')).toBeLessThanOrEqual(
        SOCKET_WRITE_CEILING_KEEP_TAIL_CHARS + BULK_WRITE_SLICE_CHARS
      )
      expect(streamSocket.writableLength).toBeLessThanOrEqual(CAP + BULK_WRITE_SLICE_CHARS)
    })
  })
})
