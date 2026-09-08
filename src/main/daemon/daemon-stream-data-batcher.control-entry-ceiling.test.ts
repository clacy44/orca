// D-R164 L1: control entries bypassed the hard socket-write ceiling entirely (only the
// held-session order latch applied), so a flooding session's own backgroundMarker/transientFact
// control entries could still deepen an already-over-ceiling socket. Held now, except 'exit' (a
// client must still learn a session died even mid-flood, since nothing else will ever deliver it)
// and 'dataGap' (that IS the ceiling's own loud-degradation signal — it must reach the client
// promptly, not wait behind the very flood it's reporting; see daemon-stream-data-batcher.ts).
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { DaemonEvent } from './types'

const CAP = 1024

function createFixedDepthSocket(writableLength: number): Socket & {
  write: ReturnType<typeof vi.fn>
} {
  return {
    destroyed: false,
    writableLength,
    write: vi.fn(() => true)
  } as unknown as Socket & { write: ReturnType<typeof vi.fn>; writableLength: number }
}

describe('DaemonStreamDataBatcher control entries vs the socket-write ceiling (D-R164 L1)', () => {
  it('holds a non-exit, non-dataGap control entry once the socket is over the ceiling', () => {
    const streamSocket = createFixedDepthSocket(CAP + 1)
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
      socketWriteCeilingBytes: CAP,
      isSessionDroppable: () => false
    })

    const backgroundMarker: DaemonEvent = {
      type: 'event',
      event: 'sessionBackgroundMarker',
      sessionId: 'session-1',
      payload: { background: true }
    }
    batcher.enqueueControlEvent('client-1', 'session-1', backgroundMarker)
    batcher.flush('client-1')

    expect(
      streamSocket.write.mock.calls.some(([line]) =>
        String(line).includes('"event":"sessionBackgroundMarker"')
      )
    ).toBe(false)
    expect(batcher.queuedCharsForClient('client-1')).toBe(0)
  })

  it('still writes an exit control entry through even over the ceiling', () => {
    const streamSocket = createFixedDepthSocket(CAP + 1)
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
      socketWriteCeilingBytes: CAP,
      isSessionDroppable: () => false
    })

    const exitEvent: DaemonEvent = {
      type: 'event',
      event: 'exit',
      sessionId: 'session-1',
      payload: { code: 0 }
    }
    batcher.enqueueControlEvent('client-1', 'session-1', exitEvent)
    batcher.flush('client-1')

    expect(streamSocket.write).toHaveBeenCalledTimes(1)
    expect(String(streamSocket.write.mock.calls[0][0])).toContain('"event":"exit"')
  })

  it('still writes a dataGap control entry through even over the ceiling (D-R164 M2/L3: the loud-degradation signal itself)', () => {
    const streamSocket = createFixedDepthSocket(CAP + 1)
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), {
      socketWriteCeilingBytes: CAP,
      isSessionDroppable: () => false
    })

    const dataGap: DaemonEvent = {
      type: 'event',
      event: 'dataGap',
      sessionId: 'session-1',
      payload: { droppedChars: 10 }
    }
    batcher.enqueueControlEvent('client-1', 'session-1', dataGap)
    batcher.flush('client-1')

    expect(streamSocket.write).toHaveBeenCalledTimes(1)
    expect(String(streamSocket.write.mock.calls[0][0])).toContain('"event":"dataGap"')
  })
})
