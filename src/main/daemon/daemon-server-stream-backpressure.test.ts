// R117 FIX 3 (D-R164 H1): the daemon pauses a session's producer once its own client stream
// socket is deep, with hysteresis (PRODUCER_PAUSE_HIGH/LOW_WATERMARK_BYTES — distinct from the
// batcher's own SHALLOW_SOCKET_WRITE_GATE_BYTES hold-gate), re-asserting under the session-side
// 5s failsafe (session.ts PRODUCER_PAUSE_FAILSAFE_MS) while it stays deep, and resumes once LOW —
// either on a later write, the reassert timer, or the socket's own 'drain' event.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonServer, PRODUCER_PAUSE_REASSERT_MS } from './daemon-server'
import { PRODUCER_PAUSE_FAILSAFE_MS } from './session'
import {
  PRODUCER_PAUSE_HIGH_WATERMARK_BYTES,
  PRODUCER_PAUSE_LOW_WATERMARK_BYTES
} from './daemon-stream-data-batcher'

// D-R167 L-4: a fake stream socket that is a REAL EventEmitter, so the 'drain' test below
// drives the actual listener setupStreamSocket() registers, not a direct method call.
class FakeStreamSocket extends EventEmitter {
  destroyed = false
  writableLength = 0
  destroy = vi.fn()
}

type FakeHost = {
  pauseProducer: ReturnType<typeof vi.fn>
  resumeProducer: ReturnType<typeof vi.fn>
}

type DaemonServerBackpressurePrivate = {
  clients: Map<string, { clientId: string; streamSocket: Socket | null }>
  host: FakeHost
  handleAfterStreamSocketWrite(clientId: string, sessionId: string): void
  resumeProducersPausedByClientDrain(clientId: string): void
  stopHeapObservabilitySampler: () => void
  producerPauseReassertTimers: Map<string, unknown>
  clearProducerPauseReassert(sessionId: string): void
  setupStreamSocket(socket: Socket, client: { clientId: string; streamSocket: Socket | null }): void
}

function createServerUnderTest(): {
  server: DaemonServerBackpressurePrivate
  fakeHost: FakeHost
  streamSocket: { destroyed: boolean; writableLength: number }
} {
  const real = new DaemonServer({
    socketPath: '/nonexistent/r117-backpressure-test.sock',
    tokenPath: '/nonexistent/r117-backpressure-test.token',
    spawnSubprocess: vi.fn()
  })
  const server = real as unknown as DaemonServerBackpressurePrivate
  const fakeHost: FakeHost = { pauseProducer: vi.fn(), resumeProducer: vi.fn() }
  server.host = fakeHost
  const streamSocket = { destroyed: false, writableLength: 0 }
  server.clients.set('client-1', {
    clientId: 'client-1',
    streamSocket: streamSocket as unknown as Socket
  })
  return { server, fakeHost, streamSocket }
}

describe('DaemonServer stream-socket backpressure (R117 FIX 3, D-R164 H1)', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('pauses the producer once the client socket reaches the HIGH watermark', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')

    expect(fakeHost.pauseProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
    expect(fakeHost.resumeProducer).not.toHaveBeenCalled()
  })

  it('resumes the producer once the socket drains below LOW', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)

    streamSocket.writableLength = 0
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
  })

  it('hysteresis: does not pause/resume per slice while the socket sits between LOW and HIGH', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    // Never crossed HIGH: no pause fired at all.
    streamSocket.writableLength = PRODUCER_PAUSE_LOW_WATERMARK_BYTES + 1
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.pauseProducer).not.toHaveBeenCalled()

    streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)

    // Drains partway (still above LOW) around the gate a few slices in a row: must not flap.
    for (let i = 0; i < 5; i++) {
      streamSocket.writableLength = PRODUCER_PAUSE_LOW_WATERMARK_BYTES + 1
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES - 1
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
    }
    expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)
    expect(fakeHost.resumeProducer).not.toHaveBeenCalled()
  })

  it('re-asserts the pause on a timer under the 5s session-side failsafe while the socket stays deep', () => {
    vi.useFakeTimers()
    try {
      const { server, fakeHost, streamSocket } = createServerUnderTest()
      cleanup = () => {
        server.stopHeapObservabilitySampler()
        server.clearProducerPauseReassert('session-1')
      }

      streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)

      // The reassert interval (4s, below the session's own 5s self-resume) must have fired again
      // by 4.5s while the socket is still reported deep.
      vi.advanceTimersByTime(4_500)
      expect(fakeHost.pauseProducer.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops reasserting and resumes once the reassert timer observes a socket below LOW', () => {
    vi.useFakeTimers()
    try {
      const { server, fakeHost, streamSocket } = createServerUnderTest()
      cleanup = () => {
        server.stopHeapObservabilitySampler()
        server.clearProducerPauseReassert('session-1')
      }

      streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(true)

      streamSocket.writableLength = 0
      vi.advanceTimersByTime(4_000)

      expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('D-R164 L2: resumes (not just stops reasserting) once the reassert timer observes the client gone', () => {
    vi.useFakeTimers()
    try {
      const { server, fakeHost, streamSocket } = createServerUnderTest()
      cleanup = () => {
        server.stopHeapObservabilitySampler()
        server.clearProducerPauseReassert('session-1')
      }

      streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(true)

      // The vanished client can never drain — a disconnect must resume, not leave the producer
      // paused until the session-side 5s failsafe.
      streamSocket.destroyed = true
      vi.advanceTimersByTime(4_000)

      expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes on the socket drain event within one tick, without waiting for the 4s reassert', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    // The pause-crossing write is the last entry of the batcher's pass: nothing else calls
    // handleAfterStreamSocketWrite again, so only the socket's own 'drain' can resume it.
    streamSocket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)
    expect(fakeHost.resumeProducer).not.toHaveBeenCalled()

    streamSocket.writableLength = 0
    server.resumeProducersPausedByClientDrain('client-1')

    expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
    expect(server.producerPauseReassertTimers.has('session-1')).toBe(false)
  })

  // D-R167 L-4: exercises the actual socket.on('drain', ...) listener (daemon-server.ts:927-932),
  // not a direct call to resumeProducersPausedByClientDrain — proves the wiring itself, not just
  // the handler it calls.
  it("resumes via the real socket 'drain' event wired up in setupStreamSocket", () => {
    const real = new DaemonServer({
      socketPath: '/nonexistent/r117-backpressure-drain-wiring-test.sock',
      tokenPath: '/nonexistent/r117-backpressure-drain-wiring-test.token',
      spawnSubprocess: vi.fn()
    })
    const server = real as unknown as DaemonServerBackpressurePrivate
    const fakeHost: FakeHost = { pauseProducer: vi.fn(), resumeProducer: vi.fn() }
    server.host = fakeHost
    const socket = new FakeStreamSocket()
    const client = { clientId: 'client-1', streamSocket: null as Socket | null }
    server.clients.set('client-1', client)
    server.setupStreamSocket(socket as unknown as Socket, client)

    try {
      socket.writableLength = PRODUCER_PAUSE_HIGH_WATERMARK_BYTES
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      expect(fakeHost.pauseProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
      expect(fakeHost.resumeProducer).not.toHaveBeenCalled()

      socket.writableLength = 0
      socket.emit('drain')

      expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1', 'socket-depth')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(false)
    } finally {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }
  })
})

describe('PRODUCER_PAUSE_REASSERT_MS (D-R167 M-3)', () => {
  it('stays under the session-side failsafe so a deep-socket pause is always re-asserted first', () => {
    expect(PRODUCER_PAUSE_REASSERT_MS).toBeLessThan(PRODUCER_PAUSE_FAILSAFE_MS)
  })
})
