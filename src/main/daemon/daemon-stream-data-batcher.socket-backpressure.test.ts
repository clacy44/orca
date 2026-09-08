// R117 FIX 1: a connected-but-slow client never drains socket.writableLength. This asserts the
// batcher stops writing once the socket crosses the hard ceiling instead of feeding it further
// (the pre-fix behavior: HELD_WRITE_THROUGH_TOTAL_CHARS writes through unconditionally past 32MB
// queued, regardless of writableLength — see diag-r117-2026-09-08.md).
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'

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

    expect(batcher.queuedCharsForClient('client-1')).toBeLessThanOrEqual(CAP)
    // The ceiling is checked before each write, so one already-in-flight slice (at most
    // BULK_WRITE_SLICE_CHARS = 64KB) can land after writableLength first crosses it — bounded
    // overshoot, not the unbounded growth asserted absent in the next test.
    expect(streamSocket.writableLength).toBeLessThanOrEqual(CAP + 64 * 1024)

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
})
