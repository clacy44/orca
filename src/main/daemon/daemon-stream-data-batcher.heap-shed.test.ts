// W2 (D-26b): at 70% heap the batcher drops every backgrounded session's queued bytes and leaves a dataGap.
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

const DSR = '\x1b[6n'

function createSocket(): Socket {
  return { destroyed: false, writableLength: 0, write: vi.fn(() => true) } as unknown as Socket
}

describe('DaemonStreamDataBatcher.shedDroppableQueues', () => {
  it('clears only backgrounded sessions, keeps salvaged queries and records a dataGap', () => {
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: createSocket() }), {
      isSessionDroppable: (sessionId) => sessionId === 'bg-session',
      salvageDroppedData: (dropped) => (dropped.includes(DSR) ? DSR : '')
    })
    batcher.enqueue('c1', 'bg-session', DSR + 'y'.repeat(50_000))
    batcher.enqueue('c1', 'fg-session', 'z'.repeat(1000))

    const outcome = batcher.shedDroppableQueues()

    expect(outcome).toEqual({ sessions: 1, droppedChars: 50_000 + DSR.length })
    const queue = (
      batcher as unknown as { pendingByClient: Map<string, PendingStreamDataBatch> }
    ).pendingByClient.get('c1')!.queue
    const bg = queue.filter((e) => e.sessionId === 'bg-session')
    expect(bg.map((e) => e.control?.event ?? e.data)).toEqual(['dataGap', DSR])
    expect(queue.filter((e) => e.sessionId === 'fg-session').map((e) => e.data.length)).toEqual([
      1000
    ])
    expect(batcher.queuedCharsForClient('c1')).toBe(1000 + DSR.length)
  })

  it('is a no-op when no backgrounded session has queued bytes', () => {
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: createSocket() }), {
      isSessionDroppable: () => false
    })
    batcher.enqueue('c1', 'fg-session', 'z'.repeat(1000))
    expect(batcher.shedDroppableQueues()).toEqual({ sessions: 0, droppedChars: 0 })
    expect(batcher.queuedCharsForClient('c1')).toBe(1000)
  })
})
