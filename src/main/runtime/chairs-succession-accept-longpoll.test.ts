// G1 attempt-3 repair F2 (from probe p14): `successionAccept` was classified 'wait', sharing the
// 12-slot sub-cap (LONG_POLL_CAP=16 - PACT_LONG_POLL_RESERVE=4) with every terminal.wait /
// check --wait / orchestration.wait / workerStart on the host. With 12 or more other parked
// waits — a normal fleet — the successor's accept got `runtime_busy` and, left parked, the hold
// timed out and the successor pane was closed. Repair: classify it 'pact' so it takes the
// reserved headroom instead of competing for the shared 12 slots. Real socket server, production
// cap; the parked waits are real `terminal.wait` calls that never resolve.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function open(endpoint: string, request: Record<string, unknown>) {
  const frames: Record<string, unknown>[] = []
  const socket = createConnection(endpoint)
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  socket.on('data', (chunk: string) => {
    buffer += chunk
    let i = buffer.indexOf('\n')
    while (i !== -1) {
      const raw = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (raw) {
        frames.push(JSON.parse(raw) as Record<string, unknown>)
      }
      i = buffer.indexOf('\n')
    }
  })
  socket.on('connect', () =>
    socket.write(
      `${JSON.stringify({ ...request, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION })}\n`
    )
  )
  return { socket, frames }
}

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out')
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('F2: successionAccept vs the long-poll admission cap', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c()
    }
  })

  it('is admitted with 12 other wait-class long polls already parked', async () => {
    const parked = 12
    const userDataPath = mkdtempSync(join(tmpdir(), 'f2-longpoll-'))
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(
      () => new Promise(() => undefined) as never
    )
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 1000 })
    await server.start()
    const sockets: ReturnType<typeof open>[] = []
    cleanups.push(async () => {
      for (const s of sockets) {
        s.socket.destroy()
      }
      await server.stop()
      db.close()
      rmSync(userDataPath, { recursive: true, force: true })
      vi.restoreAllMocks()
    })
    const md = readRuntimeMetadata(userDataPath)!
    const endpoint = md.transports[0]!.endpoint
    const authToken = md.authToken
    for (let i = 0; i < parked; i += 1) {
      sockets.push(
        open(endpoint, {
          id: `w${i}`,
          authToken,
          method: 'terminal.wait',
          params: { terminal: `term_parked_${i}`, for: 'exit', timeoutMs: 600000 }
        })
      )
    }
    await until(() => sockets.every((s) => s.frames.some((f) => f._keepalive === true)))
    const accept = open(endpoint, {
      id: 'acc',
      authToken,
      method: 'orchestration.chairs.successionAccept',
      params: { successionId: 'succ_000000000001' },
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_b',
        paneKey: 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        launchToken: 'lt'
      }
    })
    sockets.push(accept)
    // Admitted means the RPC does NOT settle terminally with runtime_busy; it either keeps parking
    // (a keepalive lands) or fails on the fake evidence for a reason OTHER than admission.
    await until(() => accept.frames.some((f) => f._keepalive === true || f.id === 'acc'))
    const busy = accept.frames.find(
      (f) => f.id === 'acc' && (f.error as { code?: string } | undefined)?.code === 'runtime_busy'
    )
    expect(busy).toBeUndefined()
  })
})
