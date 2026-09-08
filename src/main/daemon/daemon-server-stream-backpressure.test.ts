// R117 FIX 3: the daemon pauses a session's producer once its own client stream socket is deep
// (reusing SHALLOW_SOCKET_WRITE_GATE_BYTES), re-asserting under the session-side 5s failsafe
// (session.ts PRODUCER_PAUSE_FAILSAFE_MS) while it stays deep, and resumes once shallow.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonServer } from './daemon-server'
import { SHALLOW_SOCKET_WRITE_GATE_BYTES } from './daemon-stream-data-batcher'

type FakeHost = {
  pauseProducer: ReturnType<typeof vi.fn>
  resumeProducer: ReturnType<typeof vi.fn>
}

type DaemonServerBackpressurePrivate = {
  clients: Map<string, { clientId: string; streamSocket: Socket | null }>
  host: FakeHost
  handleAfterStreamSocketWrite(clientId: string, sessionId: string): void
  stopHeapObservabilitySampler: () => void
  producerPauseReassertTimers: Map<string, unknown>
  clearProducerPauseReassert(sessionId: string): void
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

describe('DaemonServer stream-socket backpressure (R117 FIX 3)', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('pauses the producer once the client socket reaches the shallow-gate depth', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    streamSocket.writableLength = SHALLOW_SOCKET_WRITE_GATE_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')

    expect(fakeHost.pauseProducer).toHaveBeenCalledWith('session-1')
    expect(fakeHost.resumeProducer).not.toHaveBeenCalled()
  })

  it('resumes the producer once the socket goes shallow again', () => {
    const { server, fakeHost, streamSocket } = createServerUnderTest()
    cleanup = () => {
      server.stopHeapObservabilitySampler()
      server.clearProducerPauseReassert('session-1')
    }

    streamSocket.writableLength = SHALLOW_SOCKET_WRITE_GATE_BYTES
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.pauseProducer).toHaveBeenCalledTimes(1)

    streamSocket.writableLength = 0
    server.handleAfterStreamSocketWrite('client-1', 'session-1')
    expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1')
  })

  it('re-asserts the pause on a timer under the 5s session-side failsafe while the socket stays deep', () => {
    vi.useFakeTimers()
    try {
      const { server, fakeHost, streamSocket } = createServerUnderTest()
      cleanup = () => {
        server.stopHeapObservabilitySampler()
        server.clearProducerPauseReassert('session-1')
      }

      streamSocket.writableLength = SHALLOW_SOCKET_WRITE_GATE_BYTES
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

  it('stops reasserting and resumes once the reassert timer observes a shallow socket', () => {
    vi.useFakeTimers()
    try {
      const { server, fakeHost, streamSocket } = createServerUnderTest()
      cleanup = () => {
        server.stopHeapObservabilitySampler()
        server.clearProducerPauseReassert('session-1')
      }

      streamSocket.writableLength = SHALLOW_SOCKET_WRITE_GATE_BYTES
      server.handleAfterStreamSocketWrite('client-1', 'session-1')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(true)

      streamSocket.writableLength = 0
      vi.advanceTimersByTime(4_000)

      expect(fakeHost.resumeProducer).toHaveBeenCalledWith('session-1')
      expect(server.producerPauseReassertTimers.has('session-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
