import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { OrcaRuntimeService } from './orca-runtime'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { isStreamingMethod, type RpcContext } from './rpc/core'
import { ACCOUNT_METHODS } from './rpc/methods/accounts'

/**
 * §5's S9b real-socket arms: two E2EE-paired clients over real `ws`, one lane each.
 *
 * The point of doing it over sockets rather than in-process is the derivation itself — the lane a
 * request addresses comes from the authenticated socket's own `pairedDeviceId`, and no parameter
 * on any of these methods can name another. The in-process calls below stand for the two caller
 * classes that HAVE no paired device id: the renderer and the anonymous local socket.
 *
 * Rev 32 (S9-L3, §10(g)) deletes `push`, `pullRotated`, `requestSwitch`, the delegable list and the
 * managed-account residency guard with the push model: a lane's file is loaded directly here in
 * place of a push, and the residency/phone-switch/malformed-envelope coverage that judged those
 * deleted mechanisms goes with them.
 */

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'
const LANE_ACCOUNT_UUID = 'acct-uuid-lane'
const HOST_SNAPSHOT = {
  claude: { accounts: [{ id: 'acct-host', email: 'host@example.com' }], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {}
}

type PairedSession = { ws: WebSocket; sharedKey: Uint8Array }

function credentials(refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${refreshToken}`,
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    }
  })
}

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

type Reader = {
  next: (id: string) => Promise<Record<string, unknown>>
  frames: Record<string, unknown>[]
  dispose: () => void
}

function createReader(session: PairedSession): Reader {
  const queued: Record<string, unknown>[] = []
  const frames: Record<string, unknown>[] = []
  const waiters: { id: string; resolve: (value: Record<string, unknown>) => void }[] = []
  const onMessage = (data: WebSocket.RawData): void => {
    const plaintext = decrypt(
      typeof data === 'string' ? data : data.toString('utf-8'),
      session.sharedKey
    )
    if (!plaintext) {
      return
    }
    const response = JSON.parse(plaintext) as Record<string, unknown>
    frames.push(response)
    const index = waiters.findIndex((waiter) => waiter.id === response.id)
    if (index === -1) {
      queued.push(response)
      return
    }
    waiters.splice(index, 1)[0]?.resolve(response)
  }
  session.ws.on('message', onMessage)
  return {
    frames,
    next: (id) => {
      const index = queued.findIndex((response) => response.id === id)
      if (index !== -1) {
        return Promise.resolve(queued.splice(index, 1)[0]!)
      }
      return new Promise((resolve) => waiters.push({ id, resolve }))
    },
    dispose: () => {
      session.ws.off('message', onMessage)
    }
  }
}

let requestSeq = 0

/** Streaming methods answer many frames under ONE id, so the id has to outlive the first read. */
function send(session: PairedSession, method: string, params?: unknown): string {
  const id = `req-${++requestSeq}`
  session.ws.send(
    encrypt(
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
      session.sharedKey
    )
  )
  return id
}

function request(
  session: PairedSession,
  reader: Reader,
  method: string,
  params?: unknown
): Promise<Record<string, unknown>> {
  const id = send(session, method, params)
  return reader.next(id)
}

function errorCode(response: Record<string, unknown>): string {
  const error = response.error as { message?: string; code?: string } | undefined
  return error?.code ?? error?.message ?? 'no_error'
}

describe('per-principal credential lanes over two paired sockets', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sessions: PairedSession[] = []
  const readers: Reader[] = []
  const dirs: string[] = []

  afterEach(async () => {
    attachLaneWireService(null)
    for (const reader of readers.splice(0)) {
      reader.dispose()
    }
    for (const session of sessions.splice(0)) {
      session.ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function startHarness(options: { provisionB?: boolean } = {}) {
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({})
    } as never)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-wire-integration-'))
    dirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    // One offer at a time, then authenticate it: the host keeps ONE pending offer, so minting
    // both up front would bind the first client's token to the second grant's row.
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
    const readerA = createReader(clientA)
    const readerB = createReader(clientB)
    readers.push(readerA, readerB)

    const lanesRoot = join(userDataPath, 'claude-lanes')
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
    if (options.provisionB !== false) {
      provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
    }
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    const bindings = new Map<string, string>([[offerA.deviceId, LANE_A]])
    if (options.provisionB !== false) {
      bindings.set(offerB.deviceId, LANE_B)
    }
    const service = new LaneWireService({
      principals: {
        principalOf: (deviceId) => bindings.get(deviceId) ?? null,
        delegatedGrantIdOf: (principalId) =>
          principalId === LANE_A ? offerA.deviceId : offerB.deviceId,
        listPrincipals: () => [
          { principalId: LANE_A, label: 'Ana' },
          { principalId: LANE_B, label: 'Ben' }
        ]
      },
      coordinator,
      switchGate: { begin: () => {}, end: () => {} },
      platform: 'linux'
    })
    attachLaneWireService(service)
    vi.spyOn(runtime, 'selectClaudeAccount').mockImplementation(
      async (accountId) => ({ accounts: [], activeAccountId: accountId }) as never
    )
    vi.spyOn(runtime, 'getAccountsSnapshot').mockReturnValue(HOST_SNAPSHOT as never)
    vi.spyOn(runtime, 'refreshAccountsForMobile').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'refreshAccountsForMobileSubscriber').mockResolvedValue(undefined)
    // `onAccountsChanged` rides the rate-limit service this harness has no account services for;
    // capturing the listener is what lets the test drive the FAN-OUT emit point, not only `ready`.
    const accountsListeners: ((snapshot: unknown) => void)[] = []
    vi.spyOn(runtime, 'onAccountsChanged').mockImplementation((listener) => {
      accountsListeners.push(listener as (snapshot: unknown) => void)
      return () => {}
    })
    return {
      emitAccountsChanged: (): void => {
        for (const listener of accountsListeners) {
          listener(HOST_SNAPSHOT)
        }
      },
      runtime,
      service,
      clientA,
      clientB,
      readerA,
      readerB,
      deviceIdA: offerA.deviceId,
      deviceIdB: offerB.deviceId,
      lanesRoot,
      /** Loads a lane's own credential file directly — the lane's CLI is the only writer (§2e). */
      loadLane: (laneId: string, refreshToken: string): void => {
        const laneDir = coordinator.store.resolveLaneDir(laneId)
        if (!laneDir) {
          throw new Error(`lane ${laneId} not provisioned`)
        }
        writeFileSync(join(laneDir, '.credentials.json'), credentials(refreshToken))
        writeFileSync(
          join(laneDir, '.claude.json'),
          JSON.stringify({
            oauthAccount: { accountUuid: LANE_ACCOUNT_UUID, emailAddress: 'ana@corp.test' }
          })
        )
      },
      laneCredentials: (laneId: string): string | null => {
        const laneDir = coordinator.store.resolveLaneDir(laneId)
        const path = laneDir ? join(laneDir, '.credentials.json') : null
        return path && existsSync(path) ? readFileSync(path, 'utf-8') : null
      }
    }
  }

  it("B's own logout never reaches A's lane", async () => {
    const harness = await startHarness()
    harness.loadLane(LANE_A, 'rt-a')
    harness.loadLane(LANE_B, 'rt-b')

    const result = await request(harness.clientB, harness.readerB, 'accounts.lane.logout')

    expect(result.error).toBeUndefined()
    expect(harness.laneCredentials(LANE_B)).toBeNull()
    // B's logout addressed B's own lane — derived from the socket, not a parameter — and A's is
    // untouched.
    expect(harness.laneCredentials(LANE_A)).toContain('rt-a')
  })

  it('refuses B selectClaude only once B holds a lane, and never an unprovisioned B', async () => {
    const unprovisioned = await startHarness({ provisionB: false })
    const allowed = await request(
      unprovisioned.clientB,
      unprovisioned.readerB,
      'accounts.selectClaude',
      { accountId: 'acct-other' }
    )
    expect(allowed.error).toBeUndefined()

    const harness = await startHarness()
    const refused = await request(harness.clientB, harness.readerB, 'accounts.selectClaude', {
      accountId: 'acct-other'
    })
    expect(errorCode(refused)).toBe('accounts.selection_out_of_scope')
  })

  it('the renderer and the anonymous local socket keep host-wide selectClaude too', async () => {
    const harness = await startHarness()
    const select = ACCOUNT_METHODS.find((method) => method.name === 'accounts.selectClaude')
    if (!select || isStreamingMethod(select)) {
      throw new Error('missing accounts.selectClaude')
    }
    for (const ctx of [
      { runtime: harness.runtime },
      { runtime: harness.runtime, clientKind: undefined }
    ]) {
      await expect(
        select.handler({ accountId: 'acct-host' }, ctx as RpcContext)
      ).resolves.toBeDefined()
    }
  })

  it('never shows B the email, identity or usage behind A lane', async () => {
    const harness = await startHarness()
    harness.loadLane(LANE_A, 'rt-1')
    const listed = await request(harness.clientB, harness.readerB, 'accounts.list', {
      refreshUsage: false
    })
    const serialized = JSON.stringify(listed.result)
    expect(serialized).not.toContain('ana@corp.test')
    expect(serialized).not.toContain(LANE_ACCOUNT_UUID)
    expect(serialized).toContain('"scope":"peer"')
    const own = await request(harness.clientA, harness.readerA, 'accounts.list', {
      refreshUsage: false
    })
    expect(JSON.stringify(own.result)).toContain('ana@corp.test')
  })

  // §5's S9b bullet names `accounts.list` AND BOTH `subscribe` emit points. Without this, both
  // projections could be reverted to the raw snapshot and the whole suite stayed green.
  it('never shows B A lane behind either accounts.subscribe emit point', async () => {
    const harness = await startHarness()
    harness.loadLane(LANE_A, 'rt-1')
    const subscriptionId = send(harness.clientB, 'accounts.subscribe')
    const ready = await harness.readerB.next(subscriptionId)
    expect((ready.result as { type: string }).type).toBe('ready')
    harness.emitAccountsChanged()
    const fanOut = await harness.readerB.next(subscriptionId)
    expect((fanOut.result as { type: string }).type).toBe('snapshot')

    for (const frame of [ready, fanOut]) {
      const serialized = JSON.stringify((frame.result as { snapshot: unknown }).snapshot)
      expect(serialized).not.toContain('ana@corp.test')
      expect(serialized).not.toContain(LANE_ACCOUNT_UUID)
      expect(serialized).toContain('"scope":"peer"')
    }
  })

  it('gives A own lane identity back on its own subscribe, so the projection is per connection', async () => {
    const harness = await startHarness()
    harness.loadLane(LANE_A, 'rt-1')
    const subscriptionId = send(harness.clientA, 'accounts.subscribe')
    const ready = await harness.readerA.next(subscriptionId)
    const serialized = JSON.stringify((ready.result as { snapshot: unknown }).snapshot)
    expect(serialized).toContain('"scope":"self"')
    expect(serialized).toContain('ana@corp.test')
  })

  it('refuses every lane method on the anonymous local socket', async () => {
    const harness = await startHarness()
    const { CLAUDE_CREDENTIAL_LANE_METHODS } = await import('./rpc/methods/claude-credential-lanes')
    const status = CLAUDE_CREDENTIAL_LANE_METHODS.find(
      (method) => method.name === 'accounts.lane.status'
    )
    if (!status || isStreamingMethod(status)) {
      throw new Error('missing accounts.lane.status')
    }
    await expect(
      status.handler(undefined, { runtime: harness.runtime } as RpcContext)
    ).rejects.toSatisfy(
      (error: unknown) =>
        isClaudeLaneRefusal(error) && error.code === 'accounts.lane.caller_unidentified'
    )
  })
})
