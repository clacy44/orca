// H3c (Ruling 32 Addendum 6(a)): the socket idle bound (RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS,
// unix-socket-transport.ts) is now injectable via UnixSocketTransportOptions.idleTimeoutMs,
// defaulting to the unchanged production constant. This suite proves the two observable halves
// of that contract against a REAL Unix socket (not a fake — the idle timer is `net.Socket`'s own
// `setTimeout`, which only fires on genuine connection inactivity):
//   1. the production constant is untouched by making the bound injectable.
//   2. a 'wait'-classified call (orchestration.wait, per runtime-rpc.ts's longPollClassOf)
//      survives multiple idle bounds because its handler arms `context.startKeepalive()`,
//      whose periodic `{"_keepalive":true}\n` writes reset the socket's idle timer.
//   3. an unclassified call on the SAME transport, held for the same duration without arming
//      keepalive, is destroyed at the bound — proving the survival above is due to the
//      keepalive wiring, not a transport that never times out.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, UnixSocketTransport } from './unix-socket-transport'

const IDLE_BOUND_MS = 150
const KEEPALIVE_INTERVAL_MS = 40
// Why 3x: the spec calls for surviving "≥3 bounds" — comfortably past a single idle window
// so a single keepalive write landing late cannot make the test pass by accident.
const HOLD_MS = IDLE_BOUND_MS * 3 + 200

type Frame = Record<string, unknown>

function openSession(
  endpoint: string,
  request: Record<string, unknown>
): {
  socket: Socket
  frames: Frame[]
  closed: Promise<{ hadFinalReply: boolean }>
} {
  const frames: Frame[] = []
  const socket = createConnection(endpoint)
  let buffer = ''
  let hadFinalReply = false
  const closed = new Promise<{ hadFinalReply: boolean }>((resolve) => {
    socket.once('close', () => resolve({ hadFinalReply }))
  })
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const raw = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const frame = JSON.parse(raw) as Frame
      frames.push(frame)
      if (frame.id === request.id && frame._keepalive !== true) {
        hadFinalReply = true
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })
  socket.once('error', () => {
    // Why: a destroyed idle connection surfaces ECONNRESET on some platforms — the 'close'
    // listener above is what the assertions key off, so swallow this to avoid an unhandled
    // rejection racing the transport's own socket.destroy().
  })
  socket.on('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`)
  })
  return { socket, frames, closed }
}

describe('UnixSocketTransport: injectable idle bound (H3c)', () => {
  let endpoint: string
  let tmpDir: string
  let transport: UnixSocketTransport | null = null

  afterEach(async () => {
    await transport?.stop()
    transport = null
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('the exported production idle-bound constant is unchanged', () => {
    expect(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS).toBe(30_000)
  })

  it('a wait-classified call survives >=3 idle bounds via keepalive; an unclassified call is destroyed at the bound', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-unix-socket-idle-bound-'))
    endpoint = join(tmpDir, 'idle-bound.sock')
    transport = new UnixSocketTransport({
      endpoint,
      kind: 'unix',
      idleTimeoutMs: IDLE_BOUND_MS,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS
    })

    transport.onMessage((raw, reply, context) => {
      const request = JSON.parse(raw) as { id: string; method: string }
      // Why this mirrors longPollClassOf: orchestration.wait is the one method that method
      // arms keepalive for on the real runtime-rpc.ts dispatcher (F-15, Ruling 32 Addendum 2)
      // — reproduced directly here since the classifier itself is a private, unexported
      // implementation detail of runtime-rpc.ts, out of scope for this transport-level test.
      const isWaitClassified = request.method === 'orchestration.wait'
      if (isWaitClassified) {
        context?.startKeepalive()
      }
      setTimeout(() => {
        reply(JSON.stringify({ id: request.id, ok: true, result: {} }))
      }, HOLD_MS)
    })
    await transport.start()

    const waitSession = openSession(endpoint, { id: 'wait-1', method: 'orchestration.wait' })
    const plainSession = openSession(endpoint, { id: 'plain-1', method: 'terminal.list' })

    const [waitOutcome, plainOutcome] = await Promise.all([waitSession.closed, plainSession.closed])

    // The wait-classified call's keepalive frames (each write resets the socket's idle timer)
    // must have arrived before the connection ever closed, and the final reply must have made
    // it through — proving the connection survived past the bound the plain call was destroyed
    // at, purely because of the keepalive wiring.
    const keepaliveFrameCount = waitSession.frames.filter((f) => f._keepalive === true).length
    expect(keepaliveFrameCount).toBeGreaterThanOrEqual(3)
    expect(waitOutcome.hadFinalReply).toBe(true)

    // The unclassified call never armed keepalive, so the real socket idle timer fires at
    // IDLE_BOUND_MS and the transport destroys it — well before HOLD_MS, and with no reply.
    expect(plainOutcome.hadFinalReply).toBe(false)
    expect(plainSession.frames.filter((f) => f._keepalive === true)).toHaveLength(0)
  })
})
