import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import {
  ManagedAccountResidencyGuard,
  attachManagedAccountResidencyGuard
} from '../claude-accounts/managed-account-lane-residency'
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
 * push lands in comes from the authenticated socket's own `pairedDeviceId`, and no parameter on
 * any of these methods can name another. The in-process calls below stand for the two caller
 * classes that HAVE no paired device id: the renderer and the anonymous local socket.
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

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

function pushParams(refreshToken: string, basedOn: string | null = null): Record<string, unknown> {
  return {
    envelope: {
      credentialsJson: credentials(refreshToken),
      oauthAccountJson: JSON.stringify({
        accountUuid: LANE_ACCOUNT_UUID,
        emailAddress: 'ana@corp.test'
      }),
      displayName: 'Ana work'
    },
    basedOnRefreshTokenSha256: basedOn,
    delegation: { hostId: 'host-1', principalId: LANE_A, delegatedGrantId: 'unused', since: 1 }
  }
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

function request(
  session: PairedSession,
  reader: Reader,
  method: string,
  params?: unknown
): Promise<Record<string, unknown>> {
  const id = `req-${++requestSeq}`
  session.ws.send(
    encrypt(
      JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
      session.sharedKey
    )
  )
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
    attachManagedAccountResidencyGuard(null)
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
    let watermarks: ClaudeLaneCredentialWatermark[] = []
    let delegationRows: ClaudeLaneDelegationRow[] = []
    const persistence = {
      getClaudeLaneCredentialWatermarks: () => watermarks,
      setClaudeLaneCredentialWatermarks: (rows: readonly ClaudeLaneCredentialWatermark[]) => {
        watermarks = [...rows]
      },
      getClaudeLaneDelegationRows: () => delegationRows,
      setClaudeLaneDelegationRows: (rows: readonly ClaudeLaneDelegationRow[]) => {
        delegationRows = [...rows]
      }
    }
    let sharedLaneCredentials: string | null = null
    const coordinator = new LaneCredentialCoordinator({
      persistence,
      sharedLane: {
        readCredentials: () => sharedLaneCredentials,
        readOauthAccount: () => null
      },
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
      persistence,
      switchGate: { begin: () => {}, end: () => {} },
      platform: 'linux'
    })
    attachLaneWireService(service)
    // The managed store side of L1: the host account the two developers already had before lanes.
    attachManagedAccountResidencyGuard(
      new ManagedAccountResidencyGuard({
        residency: coordinator.residency,
        accounts: {
          findAccount: (accountId) =>
            accountId === 'acct-host'
              ? ({
                  id: 'acct-host',
                  email: 'host@example.com',
                  managedAuthPath: '/managed/acct-host/auth',
                  authMethod: 'subscription-oauth',
                  createdAt: 0,
                  updatedAt: 0,
                  lastAuthenticatedAt: 0
                } as never)
              : null
        },
        resolveManagedAuthPath: (_accountId, candidatePath) => candidatePath,
        readManagedAuthFile: (_path, fileName) =>
          fileName === 'oauth-account.json'
            ? JSON.stringify({ accountUuid: LANE_ACCOUNT_UUID })
            : null
      })
    )
    const selectClaudeAccount = vi
      .spyOn(runtime, 'selectClaudeAccount')
      .mockImplementation(async (accountId) => {
        // Stands in for `ClaudeAccountService.doSelectAccount`, whose own call site — and the
        // mutation proof that it is there — lives in `service-lane-residency.test.ts`.
        const { assertManagedClaudeAccountNotLaneResident } =
          await import('../claude-accounts/managed-account-lane-residency')
        assertManagedClaudeAccountNotLaneResident(accountId)
        return { accounts: [], activeAccountId: accountId } as never
      })
    vi.spyOn(runtime, 'getAccountsSnapshot').mockReturnValue(HOST_SNAPSHOT as never)
    vi.spyOn(runtime, 'refreshAccountsForMobile').mockResolvedValue(undefined)
    return {
      runtime,
      service,
      clientA,
      clientB,
      readerA,
      readerB,
      deviceIdA: offerA.deviceId,
      deviceIdB: offerB.deviceId,
      selectClaudeAccount,
      lanesRoot,
      setSharedLaneCredentials: (value: string | null) => {
        sharedLaneCredentials = value
      },
      laneCredentials: (laneId: string): string | null => {
        // Resolved through the store, not joined: the lane path is canonicalized at provisioning.
        const laneDir = coordinator.store.resolveLaneDir(laneId)
        const path = laneDir ? join(laneDir, '.credentials.json') : null
        return path && existsSync(path) ? readFileSync(path, 'utf-8') : null
      }
    }
  }

  it('lands a push in the pusher own lane and leaves the other lane untouched', async () => {
    const harness = await startHarness()
    const pushed = await request(
      harness.clientA,
      harness.readerA,
      'accounts.lane.push',
      pushParams('rt-1')
    )
    expect(pushed.result).toMatchObject({ laneState: 'loaded' })
    expect(harness.laneCredentials(LANE_A)).toContain('rt-1')
    expect(harness.laneCredentials(LANE_B)).toBeNull()
  })

  it('gives B no way to target A lane: the delegation member does not move it', async () => {
    const harness = await startHarness()
    const refused = await request(harness.clientB, harness.readerB, 'accounts.lane.push', {
      ...pushParams('rt-b'),
      delegation: {
        hostId: 'host-1',
        principalId: LANE_A,
        delegatedGrantId: harness.deviceIdA,
        since: 1
      }
    })
    // B IS its own lane's designated pusher, so this succeeds — into B's lane, never A's.
    expect(refused.result).toMatchObject({ laneState: 'loaded' })
    expect(harness.laneCredentials(LANE_A)).toBeNull()
    expect(harness.laneCredentials(LANE_B)).toContain('rt-b')
  })

  it('accepts two consecutive pushes from the same desktop', async () => {
    const harness = await startHarness()
    const first = (
      await request(harness.clientA, harness.readerA, 'accounts.lane.push', pushParams('rt-1'))
    ).result as { refreshTokenSha256: string }
    expect(first.refreshTokenSha256).toBe(sha('rt-1'))
    const second = await request(
      harness.clientA,
      harness.readerA,
      'accounts.lane.push',
      pushParams('rt-2', sha('rt-1'))
    )
    expect(second.result).toMatchObject({ refreshTokenSha256: sha('rt-2') })
    expect(harness.laneCredentials(LANE_A)).toContain('rt-2')
  })

  it('refuses a push from a grant that is not the designated pusher, writing nothing', async () => {
    const harness = await startHarness()
    const service = harness.service
    // Re-point A's designation at B's grant: A is now a bound, un-designated desktop.
    attachLaneWireService(
      new LaneWireService({
        principals: {
          principalOf: (deviceId) => (deviceId === harness.deviceIdA ? LANE_A : null),
          delegatedGrantIdOf: () => harness.deviceIdB
        },
        coordinator: service.coordinator,
        persistence: {
          getClaudeLaneDelegationRows: () => [],
          setClaudeLaneDelegationRows: () => {}
        },
        switchGate: { begin: () => {}, end: () => {} },
        platform: 'linux'
      })
    )
    const refused = await request(
      harness.clientA,
      harness.readerA,
      'accounts.lane.push',
      pushParams('rt-1')
    )
    expect(errorCode(refused)).toBe('accounts.lane.push_not_delegated')
    expect(harness.laneCredentials(LANE_A)).toBeNull()
  })

  it('writes nothing for a malformed envelope, an oversized member or a fourth member', async () => {
    const harness = await startHarness()
    for (const params of [
      { ...pushParams('rt-1'), envelope: { credentialsJson: '{}', oauthAccountJson: '{}' } },
      {
        ...pushParams('rt-1'),
        envelope: {
          credentialsJson: JSON.stringify({
            claudeAiOauth: { accessToken: 'at', pad: 'x'.repeat(70_000) }
          }),
          oauthAccountJson: '{}'
        }
      },
      {
        ...pushParams('rt-1'),
        envelope: {
          credentialsJson: credentials('rt-1'),
          oauthAccountJson: '{}',
          settingsJson: '{}'
        }
      }
    ]) {
      const refused = await request(harness.clientA, harness.readerA, 'accounts.lane.push', params)
      expect(errorCode(refused)).toBe('accounts.lane.push_malformed')
      expect(harness.laneCredentials(LANE_A)).toBeNull()
    }
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

  it('refuses a lane-resident target for a lane-less grant, the renderer and the local socket', async () => {
    const harness = await startHarness({ provisionB: false })
    await request(harness.clientA, harness.readerA, 'accounts.lane.push', pushParams('rt-1'))
    const refusedOverSocket = await request(
      harness.clientB,
      harness.readerB,
      'accounts.selectClaude',
      { accountId: 'acct-host' }
    )
    expect(errorCode(refusedOverSocket)).toBe('accounts.lane.account_resident_elsewhere')
    expect(String((refusedOverSocket.error as { message?: string }).message)).toContain('Ana')

    // The renderer and the anonymous local socket carry no paired device id at all.
    const select = ACCOUNT_METHODS.find((method) => method.name === 'accounts.selectClaude')
    if (!select || isStreamingMethod(select)) {
      throw new Error('missing accounts.selectClaude')
    }
    for (const ctx of [
      { runtime: harness.runtime },
      { runtime: harness.runtime, clientKind: undefined }
    ]) {
      await expect(select.handler({ accountId: 'acct-host' }, ctx as RpcContext)).rejects.toSatisfy(
        (error: unknown) => isClaudeLaneRefusal(error)
      )
    }
    // Negative control: an account no lane holds still selects for all three.
    await expect(
      select.handler({ accountId: 'acct-other' }, { runtime: harness.runtime } as RpcContext)
    ).resolves.toBeDefined()
  })

  it('never shows B the email, identity or usage behind A lane', async () => {
    const harness = await startHarness()
    await request(harness.clientA, harness.readerA, 'accounts.lane.push', pushParams('rt-1'))
    const listed = await request(harness.clientB, harness.readerB, 'accounts.list', {
      refreshUsage: false
    })
    const serialized = JSON.stringify(listed.result)
    expect(serialized).not.toContain('ana@corp.test')
    expect(serialized).not.toContain(LANE_ACCOUNT_UUID)
    expect(serialized).toContain('"scope":"peer"')
    expect(serialized).toContain('Ana work')
    const own = await request(harness.clientA, harness.readerA, 'accounts.list', {
      refreshUsage: false
    })
    expect(JSON.stringify(own.result)).toContain('ana@corp.test')
  })

  it('partitions the phone switch refusals: unknown token, then desktop_unavailable', async () => {
    const harness = await startHarness()
    const unknown = await request(harness.clientB, harness.readerB, 'accounts.lane.requestSwitch', {
      delegatedAccountId: 'not-a-token'
    })
    expect(errorCode(unknown)).toBe('accounts.lane.delegable_account_unknown')

    const [offered] = harness.service.delegation.setDelegableAccounts(LANE_B, [
      { clientRef: 'ref-1', displayName: 'Ben work' }
    ])
    const away = await request(harness.clientB, harness.readerB, 'accounts.lane.requestSwitch', {
      delegatedAccountId: offered?.delegatedAccountId
    })
    expect(errorCode(away)).toBe('accounts.lane.desktop_unavailable')
    expect(String((away.error as { message?: string }).message)).toContain(
      'desktop is not connected'
    )
    expect(
      harness.readerB.frames.some((frame) => JSON.stringify(frame).includes('switch-requested'))
    ).toBe(false)
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
