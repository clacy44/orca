/**
 * §5's S9b attribution arm over real sockets: the grant a terminal row's usage bar is projected
 * FOR comes from the authenticated socket, and no parameter on `terminal.list` can name another.
 *
 * Done over `ws` rather than in-process for the same reason the lane-wire suite is: the
 * derivation itself is the claim (§2d, §2k).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { OrcaRuntimeService } from './orca-runtime'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type PairedSession = { ws: WebSocket; sharedKey: Uint8Array }

function connect(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(typeof data === 'string' ? data : data.toString('utf-8')))
  })
}

async function authenticate(pairingUrl: string): Promise<PairedSession> {
  const pairing = parsePairingCode(pairingUrl)
  if (!pairing) {
    throw new Error('invalid_pairing_url')
  }
  const ws = await connect(pairing.endpoint)
  const keys = generateKeyPair()
  const sharedKey = deriveSharedKey(
    keys.secretKey,
    Uint8Array.from(Buffer.from(pairing.publicKeyB64, 'base64'))
  )
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    })
  )
  await nextMessage(ws)
  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: pairing.deviceToken }), sharedKey)
  )
  await nextMessage(ws)
  return { ws, sharedKey }
}

let requestSeq = 0

async function request(
  session: PairedSession,
  method: string,
  params?: unknown
): Promise<Record<string, unknown>> {
  const id = `req-${++requestSeq}`
  const response = nextMessage(session.ws)
  session.ws.send(
    encrypt(
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
      session.sharedKey
    )
  )
  const plaintext = decrypt(await response, session.sharedKey)
  return JSON.parse(plaintext ?? '{}') as Record<string, unknown>
}

describe('terminal.list projects the lane usage bar for the calling socket only', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sessions: PairedSession[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes each socket's own grant, and no parameter can name another", async () => {
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({})
    } as never)
    const seen: (string | null | undefined)[] = []
    vi.spyOn(runtime, 'listTerminals').mockImplementation(async (_worktree, _limit, opts) => {
      seen.push(opts?.pairedDeviceId ?? null)
      return { terminals: [], topologyRevisions: {}, totalCount: 0, truncated: false }
    })
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-usage-row-'))
    dirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const offerA = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'client-a',
      scope: 'runtime'
    })
    if (!offerA.available) {
      throw new Error('pairing_unavailable')
    }
    const clientA = await authenticate(offerA.pairingUrl)
    const offerB = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'client-b',
      scope: 'runtime'
    })
    if (!offerB.available) {
      throw new Error('pairing_unavailable')
    }
    const clientB = await authenticate(offerB.pairingUrl)
    sessions.push(clientA, clientB)

    await request(clientA, 'terminal.list')
    // B asks while naming A's grant in the params: the schema is non-strict, so the field is
    // simply not read — the socket's own identity is the only source (§2d).
    await request(clientB, 'terminal.list', { pairedDeviceId: offerA.deviceId })

    expect(seen).toEqual([offerA.deviceId, offerB.deviceId])
  })
})
