// R2 (D-26b): past the socket-write ceiling, the salvaged query copy a keep-tail drop leaves at the
// queue head was re-dropped and re-salvaged forever, so flush() never returned. The whole session's
// remaining entries must be held in order, and the hold must be logged.
import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

const DSR = '\x1b[6n'
const OVER_CEILING = 64 * 1024 * 1024 + 1
const KEEP_TAIL = 128 * 1024

function createRunawayGuardSocket(maxReads: number): {
  socket: Socket
  reads: () => number
} {
  let reads = 0
  const socket = {
    destroyed: false,
    get writableLength(): number {
      reads += 1
      if (reads > maxReads) {
        throw new Error(`writableLength tripwire: read more than ${maxReads} times`)
      }
      return OVER_CEILING
    },
    write: vi.fn(() => true)
  } as unknown as Socket
  return { socket, reads: () => reads }
}

function pendingBatch(batcher: DaemonStreamDataBatcher, clientId: string): PendingStreamDataBatch {
  return (
    batcher as unknown as { pendingByClient: Map<string, PendingStreamDataBatch> }
  ).pendingByClient.get(clientId) as PendingStreamDataBatch
}

describe('DaemonStreamDataBatcher socket-write ceiling livelock (D-26b R2)', () => {
  it('returns from flush and retains [dataGap, salvaged query, keep-tail] in order', () => {
    const { socket, reads } = createRunawayGuardSocket(10_000)
    const onCeilingHold = vi.fn()
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }), {
      socketWriteCeilingBytes: 1024,
      isSessionDroppable: () => false,
      salvageDroppedData: (dropped) => (dropped.includes(DSR) ? DSR : ''),
      onCeilingHold
    })
    batcher.enqueue('client-1', 'session-flood-1', DSR + 'x'.repeat(200 * 1024 - DSR.length))

    expect(() => batcher.flush('client-1')).not.toThrow()
    expect(reads()).toBeLessThan(100)

    const queue = pendingBatch(batcher, 'client-1').queue
    expect(queue).toHaveLength(3)
    expect(queue[0].control?.event).toBe('dataGap')
    expect(queue[1]).toMatchObject({ data: DSR, salvage: true })
    expect(queue[2].data.length).toBeLessThanOrEqual(KEEP_TAIL)
    expect(queue[2].data.length).toBeGreaterThanOrEqual(KEEP_TAIL - 4096)
    expect(batcher.queuedCharsForClient('client-1')).toBeLessThanOrEqual(KEEP_TAIL + 4096)

    expect(onCeilingHold).toHaveBeenCalledTimes(1)
    expect(onCeilingHold).toHaveBeenCalledWith({
      sessionId: 'session-flood-1',
      writableLength: OVER_CEILING,
      droppedChars: 200 * 1024 - KEEP_TAIL
    })
  })

  it('converges: repeated over-ceiling passes stop changing the queue and never re-drop the salvage', () => {
    const { socket } = createRunawayGuardSocket(10_000)
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }), {
      socketWriteCeilingBytes: 1024,
      isSessionDroppable: () => false,
      salvageDroppedData: (dropped) => (dropped.includes(DSR) ? DSR : ''),
      onCeilingHold: vi.fn()
    })
    batcher.enqueue('client-1', 'session-flood-1', DSR + 'x'.repeat(200 * 1024 - DSR.length))
    const shape = (): (string | number | undefined)[][] =>
      pendingBatch(batcher, 'client-1').queue.map((e) => [e.control?.event, e.data.length])
    for (let pass = 0; pass < 3; pass++) {
      batcher.flush('client-1')
    }
    const settled = shape()
    batcher.flush('client-1')
    batcher.flush('client-1')
    expect(shape()).toEqual(settled)
    expect(batcher.queuedCharsForClient('client-1')).toBeLessThanOrEqual(KEEP_TAIL + 4096)
    expect(
      pendingBatch(batcher, 'client-1').queue.filter((e) => e.salvage && e.data === DSR)
    ).toHaveLength(1)
  })
})
