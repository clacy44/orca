/**
 * Release-audit T2: the ONE end-to-end test that boots the PRODUCTION wiring path — real
 * `setLaneWireHostDependencies` + `attachPrincipalLaneHost` (the same call chain `index.ts` and
 * `OrcaRuntimeRpcServer.start()` use), never a hand-built `LaneWireService` — and drives the
 * whole day-one flow over a real socket: create-person → bind → designate → provision → a push
 * over the socket (through the real `LaneDelegationPushClient`, never hand-built push params) →
 * the lane loaded → a lane-pinned spawn's env carrying `CLAUDE_CONFIG_DIR` → the last socket
 * close → the credential file gone.
 *
 * `lane-wire-composition.test.ts` (B1) and `principal-lane-close-wipe.integration.test.ts` (S9c)
 * each cover one half of this over their own harness; this is the one place both halves run
 * together through the real composition, so a regression that only breaks the WIRING between them
 * — not either class on its own — fails here. The negative arms below (push_not_delegated,
 * selection_out_of_scope, grant_not_redeemed) are reachable only because the wiring is real.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { prepareLaneLaunch } from '../claude-accounts/principal-lane-preparation'
import {
  LaneDelegationPushClient,
  type DesktopLaneAccountSource,
  type LaneDelegationHostClient
} from '../claude-accounts/lane-delegation-push-client'
import { LaneDelegationLeaseStore } from '../claude-accounts/lane-delegation-lease'
import { paneLaneLaunchFor } from '../ipc/lane-pinned-spawn'
import { computeLaneLaunch, type LaneLaunchSpawnShape } from './lane-launch-computation'
import { OrcaRuntimeService } from './orca-runtime'
import { getLaneWireService } from './lane-wire-service'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import { PrincipalRegistry, type PrincipalGrantRow } from './principal-registry'
import {
  PrincipalLaneConsentService,
  getPrincipalLaneConsentService
} from './principal-lane-consent-service'
import { deriveSharedKey, encrypt, decrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

// The consent service's own `provisionLane` resolves the lanes root through `app.getPath`
// (no lanesRoot override on that surface, unlike the lower-level `provisionPrincipalLane` calls
// other lane tests make directly) — mocked so it lands under the same userDataPath as the rest.
const electronState = { userDataPath: '' }
vi.mock('electron', () => ({ app: { getPath: () => electronState.userDataPath } }))

const CONSENT = { source: 'local-socket' } as const

/** The minimal `PrincipalGrantSource` the B2 override arm needs — no real pairing socket. */
class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true

  add(deviceId: string): void {
    this.rows = [
      ...this.rows,
      {
        deviceId,
        name: 'Ana',
        token: `token-${deviceId}`,
        pairedAt: 1,
        lastSeenAt: 1,
        pendingExpiresAt: Date.now() + 60_000
      }
    ]
  }

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

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

type PairedSession = { ws: WebSocket; sharedKey: Uint8Array }

/** Called twice on ONE pairing URL = two sockets on ONE grant (the close-wipe negative arm). */
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
  dispose: () => void
}

function createReader(session: PairedSession): Reader {
  const queued: Record<string, unknown>[] = []
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
    const index = waiters.findIndex((waiter) => waiter.id === response.id)
    if (index === -1) {
      queued.push(response)
      return
    }
    waiters.splice(index, 1)[0]?.resolve(response)
  }
  session.ws.on('message', onMessage)
  return {
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

function closeAndSettle(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => setTimeout(resolve, 60))
    ws.close()
  })
}

/** A production `LaneDelegationHostClient` over a real socket — the transport this test proves. */
function socketHostClient(
  session: PairedSession,
  reader: Reader,
  hostId: string
): LaneDelegationHostClient {
  return {
    hostId,
    getCapabilities: async () => [AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY],
    call: async <T>(method: string, params?: unknown) => {
      const response = await request(session, reader, method, params)
      if (response.error) {
        throw new Error(JSON.stringify(response.error))
      }
      return response.result as T
    },
    // The electron-IPC transport (`lane-delegation-host-client.ts`) cannot run in vitest and gets
    // its own unit test for method names and frame mapping; this test's one push never needs a
    // live status frame — `LaneDelegationPushClient.resolveDelegation` falls back to a one-shot
    // `accounts.lane.status` call when no `ready` frame has landed yet, which is exercised below.
    subscribeLaneStatus: async () => () => {}
  }
}

describe('principal lanes over the production wiring, end to end (release-audit T2)', () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sockets: WebSocket[] = []
  const dirs: string[] = []

  afterEach(async () => {
    setLaneWireHostDependencies(null)
    for (const ws of sockets.splice(0)) {
      ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  type Persistence = {
    getClaudeLaneCredentialWatermarks: () => ClaudeLaneCredentialWatermark[]
    setClaudeLaneCredentialWatermarks: (rows: readonly ClaudeLaneCredentialWatermark[]) => void
    getClaudeLaneDelegationRows: () => ClaudeLaneDelegationRow[]
    setClaudeLaneDelegationRows: (rows: readonly ClaudeLaneDelegationRow[]) => void
    getClaudeLaneDelegationLeases: () => ClaudeLaneDelegationLease[]
    setClaudeLaneDelegationLeases: (rows: readonly ClaudeLaneDelegationLease[]) => void
  }

  function makePersistence(): Persistence {
    let watermarks: ClaudeLaneCredentialWatermark[] = []
    let delegationRows: ClaudeLaneDelegationRow[] = []
    let leases: ClaudeLaneDelegationLease[] = []
    return {
      getClaudeLaneCredentialWatermarks: () => watermarks,
      setClaudeLaneCredentialWatermarks: (rows) => {
        watermarks = [...rows]
      },
      getClaudeLaneDelegationRows: () => delegationRows,
      setClaudeLaneDelegationRows: (rows) => {
        delegationRows = [...rows]
      },
      getClaudeLaneDelegationLeases: () => leases,
      setClaudeLaneDelegationLeases: (rows) => {
        leases = [...rows]
      }
    }
  }

  async function startHarness() {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-production-wiring-'))
    electronState.userDataPath = userDataPath
    dirs.push(userDataPath)
    const lanesRoot = join(userDataPath, 'claude-lanes')

    // The exact dependency-registration `index.ts` performs before any registry exists (B1/B3).
    const persistence = makePersistence()
    const coordinator = new LaneCredentialCoordinator({
      persistence,
      sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    setLaneWireHostDependencies({
      coordinator,
      persistence,
      accounts: { findAccount: () => null }
    })

    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({})
    } as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    // Internally: attachPrincipalLaneHost -> attachComposedLaneWire(registry) — the real wire,
    // composed from the real dependencies registered above. No hand-built LaneWireService.
    await server.start()

    const consent = getPrincipalLaneConsentService()
    if (!consent) {
      throw new Error('consent_surface_unattached')
    }

    const mintGrant = (name: string) => {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name,
        scope: 'runtime',
        mint: 'always'
      })
      if (!offer.available) {
        throw new Error('pairing_unavailable')
      }
      return offer
    }

    return { userDataPath, lanesRoot, persistence, runtime, server, consent, mintGrant }
  }

  it(
    'create-person, bind, designate, provision, push through the real push client over ' +
      'the socket, lane loaded, a lane-pinned spawn env, then last-close wipe — all through ' +
      'the production wire',
    async () => {
      const { lanesRoot, persistence, runtime, consent, mintGrant } = await startHarness()
      expect(getLaneWireService()).not.toBeNull()

      // A per-person invite, redeemed by the real E2EE handshake BEFORE any bind (M1's precondition).
      const desktopOffer = mintGrant('ana-desktop')
      const desktop = await authenticate(desktopOffer.pairingUrl)
      const desktopReader = createReader(desktop)
      sockets.push(desktop.ws)

      // create-person -> bind -> designate -> provision, through the production consent service —
      // the same object every `accounts.lane.*` host-only RPC and the CLI forward into.
      const ana = consent.createPrincipal(CONSENT, 'Ana')
      consent.bindGrant(CONSENT, desktopOffer.deviceId, ana.principalId)
      consent.designatePusher(CONSENT, ana.principalId, desktopOffer.deviceId)
      // B2's override is exercised on the gated platforms in the dedicated arm below; this host
      // runs the happy path on linux, which is never gated, so no flag is needed here.
      const lane = consent.provisionLane(CONSENT, ana.principalId)
      expect(lane.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)
      const laneDir = join(lanesRoot, ana.principalId)
      const credentialPath = join(laneDir, '.credentials.json')
      expect(existsSync(laneDir)).toBe(true)

      // The provision audit row, carrying no platformAcceptance on this ungated platform.
      const audit = consent.listAudit()
      const provisionRow = audit.find(
        (row) => row.action === 'provision' && row.principalId === ana.principalId
      )
      expect(provisionRow).toBeDefined()
      expect(provisionRow?.platformAcceptance).toBeUndefined()

      // Lane derivation over the production lookup, fed by attachPrincipalLaneHost's own wiring.
      expect(runtime.resolveCallerCredentialLane(desktopOffer.deviceId)).toEqual({
        kind: 'principal',
        principalId: ana.principalId
      })

      // A provisioned but not-yet-pushed lane still throws `terminal.lane_not_loaded` — this is
      // the exact call the production preparation makes at runtime-auth-service.ts:673-681; the
      // one hop above it (pty.ts -> prepareClaudeAuth) is already covered by lane-pinned-spawn.test.ts
      // and orca-runtime-agent-session-lane-args.test.ts.
      expect(() =>
        prepareLaneLaunch({ principalId: ana.principalId, lanesRoot, platform: 'linux' })
      ).toThrowError(/lane_not_loaded|not loaded/)
      try {
        prepareLaneLaunch({ principalId: ana.principalId, lanesRoot, platform: 'linux' })
        throw new Error('expected a throw')
      } catch (error) {
        expect(isClaudeLaneRefusal(error) && error.code).toBe('terminal.lane_not_loaded')
      }

      // The desktop push client's own act: a credential envelope pushed over the paired socket,
      // through the real production `LaneDelegationPushClient` — no hand-built push params. It
      // supplies `basedOnRefreshTokenSha256` and the delegation object itself, from a one-shot
      // `accounts.lane.status` call (no `ready` frame ever arrives from the stub subscription).
      const accounts: DesktopLaneAccountSource = {
        readSelected: async () => ({
          accountId: 'acct-ana',
          accountUuid: 'acct-uuid-ana',
          credentialsJson: credentials('rt-ana-1'),
          oauthAccountJson: JSON.stringify({
            accountUuid: 'acct-uuid-ana',
            emailAddress: 'ana@corp.test'
          }),
          displayName: 'Ana work'
        }),
        readByClientRef: async () => null,
        listDelegable: async () => [],
        applyRotatedCredentials: async () => {},
        resolveLocalAccountId: () => null
      }
      const leases = new LaneDelegationLeaseStore({ persistence })
      const pushClient = new LaneDelegationPushClient({
        host: socketHostClient(desktop, desktopReader, 'env-test'),
        accounts,
        leases
      })
      const outcome = await pushClient.connect()
      expect(outcome).toBe('pushed')

      expect(existsSync(credentialPath)).toBe(true)
      expect(readFileSync(credentialPath, 'utf-8')).toContain('rt-ana-1')

      // The host's own status projection over the socket agrees with what the push client saw.
      const status = await request(desktop, desktopReader, 'accounts.lane.status')
      expect(status.result).toMatchObject({
        laneState: 'loaded',
        callerIsDelegatedGrant: true,
        heldDisplayName: 'Ana work'
      })

      // A lane-pinned spawn's env carries this principal's CLAUDE_CONFIG_DIR — the same
      // preparation + computation the PTY spawn anchor runs, over the lane the push just loaded.
      const preparation = prepareLaneLaunch({
        principalId: ana.principalId,
        lanesRoot,
        platform: 'linux'
      })
      expect(preparation.envPatch?.CLAUDE_CONFIG_DIR).toBe(laneDir)
      expect(preparation.stripAuthEnv).toBe(true)
      const paneLane = paneLaneLaunchFor({
        lanePrincipalId: ana.principalId,
        envPatch: preparation.envPatch
      })
      const spawnOptions: LaneLaunchSpawnShape = { env: { PATH: '/usr/bin' } }
      const computed = computeLaneLaunch(paneLane, spawnOptions)
      expect(computed.spawnOptions.env?.CLAUDE_CONFIG_DIR).toBe(laneDir)
      expect(computed.spawnOptions.credentialLane).toEqual({ principalId: ana.principalId })

      // Negative arm: a SECOND socket on the desktop's own grant. Closing one of them wipes
      // nothing (§5's `hasOtherConnections` predicate, keyed by the GRANT).
      const secondDesktop = await authenticate(desktopOffer.pairingUrl)
      sockets.push(secondDesktop.ws)
      await closeAndSettle(secondDesktop.ws)
      expect(existsSync(credentialPath)).toBe(true)

      // Negative arm: a SECOND grant on the same principal. Closing the phone's socket alone
      // wipes nothing either — the lane's answer is the PRINCIPAL's, not any one grant's.
      const phoneOffer = mintGrant('ana-phone')
      const phone = await authenticate(phoneOffer.pairingUrl)
      sockets.push(phone.ws)
      consent.bindGrant(CONSENT, phoneOffer.deviceId, ana.principalId)

      // The desktop grant's LAST socket: the phone is still connected on the same principal.
      await closeAndSettle(desktop.ws)
      expect(existsSync(credentialPath)).toBe(true)

      // The principal's true last close: the production close hook
      // (runtime-rpc.ts -> principal-lane-connection-lifecycle.ts) wipes the credential.
      await closeAndSettle(phone.ws)
      expect(existsSync(credentialPath)).toBe(false)
      // The watermark (and the lane directory) survive the wipe, same as the close-wipe suite.
      const watermarks = persistence.getClaudeLaneCredentialWatermarks()
      expect(watermarks.some((row) => row.laneId === ana.principalId)).toBe(true)
      expect(existsSync(laneDir)).toBe(true)

      // Step 6's throw returns once the lane is wiped.
      try {
        prepareLaneLaunch({ principalId: ana.principalId, lanesRoot, platform: 'linux' })
        throw new Error('expected a throw')
      } catch (error) {
        expect(isClaudeLaneRefusal(error) && error.code).toBe('terminal.lane_not_loaded')
      }
    }
  )

  it('leaves the wire unattached without host dependencies, refusing every accounts.lane.* call', async () => {
    // Deliberately no `setLaneWireHostDependencies` before start.
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-production-wiring-unwired-'))
    electronState.userDataPath = userDataPath
    dirs.push(userDataPath)
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({})
    } as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    expect(getLaneWireService()).toBeNull()

    const offer = server.createPairingOffer({
      address: '127.0.0.1',
      name: 'ana-desktop',
      scope: 'runtime',
      mint: 'always'
    })
    if (!offer.available) {
      throw new Error('pairing_unavailable')
    }
    const desktop = await authenticate(offer.pairingUrl)
    const reader = createReader(desktop)
    sockets.push(desktop.ws)

    const pushed = await request(desktop, reader, 'accounts.lane.push', {
      envelope: {
        credentialsJson: credentials('rt-1'),
        oauthAccountJson: '{}',
        displayName: 'Ana work'
      },
      basedOnRefreshTokenSha256: null,
      delegation: { hostId: 'h', principalId: 'p', delegatedGrantId: offer.deviceId, since: 1 }
    })
    expect(errorCode(pushed)).toBe('accounts.lane.not_enabled')

    const status = await request(desktop, reader, 'accounts.lane.status')
    expect(errorCode(status)).toBe('accounts.lane.not_enabled')
  })

  it('refuses a push from a grant that is not the designated pusher', async () => {
    const { consent, mintGrant } = await startHarness()

    const desktopOffer = mintGrant('ana-desktop')
    const desktop = await authenticate(desktopOffer.pairingUrl)
    sockets.push(desktop.ws)
    const otherOffer = mintGrant('ana-other')
    const other = await authenticate(otherOffer.pairingUrl)
    const otherReader = createReader(other)
    sockets.push(other.ws)

    const ana = consent.createPrincipal(CONSENT, 'Ana')
    consent.bindGrant(CONSENT, desktopOffer.deviceId, ana.principalId)
    consent.bindGrant(CONSENT, otherOffer.deviceId, ana.principalId)
    consent.designatePusher(CONSENT, ana.principalId, desktopOffer.deviceId)
    consent.provisionLane(CONSENT, ana.principalId)

    const refused = await request(other, otherReader, 'accounts.lane.push', {
      envelope: {
        credentialsJson: credentials('rt-1'),
        oauthAccountJson: '{}',
        displayName: 'Ana work'
      },
      basedOnRefreshTokenSha256: null,
      delegation: {
        hostId: 'h',
        principalId: ana.principalId,
        delegatedGrantId: otherOffer.deviceId,
        since: 1
      }
    })
    expect(errorCode(refused)).toBe('accounts.lane.push_not_delegated')
  })

  it('refuses accounts.selectClaude from a grant that holds a provisioned lane', async () => {
    const { consent, mintGrant } = await startHarness()

    const desktopOffer = mintGrant('ana-desktop')
    const desktop = await authenticate(desktopOffer.pairingUrl)
    const reader = createReader(desktop)
    sockets.push(desktop.ws)

    const ana = consent.createPrincipal(CONSENT, 'Ana')
    consent.bindGrant(CONSENT, desktopOffer.deviceId, ana.principalId)
    consent.designatePusher(CONSENT, ana.principalId, desktopOffer.deviceId)
    consent.provisionLane(CONSENT, ana.principalId)

    const refused = await request(desktop, reader, 'accounts.selectClaude', {
      accountId: 'acct-other'
    })
    expect(errorCode(refused)).toBe('accounts.selection_out_of_scope')
  })

  it('refuses bind/designate against an un-redeemed invite (M1)', async () => {
    const { consent, mintGrant } = await startHarness()

    // Minted, never authenticated: lastSeenAt stays 0.
    const offer = mintGrant('ana-pending')
    const ana = consent.createPrincipal(CONSENT, 'Ana')

    expect(() => consent.bindGrant(CONSENT, offer.deviceId, ana.principalId)).toThrowError(/invite/)
    try {
      consent.bindGrant(CONSENT, offer.deviceId, ana.principalId)
      throw new Error('expected a throw')
    } catch (error) {
      expect(isClaudeLaneRefusal(error) && error.code).toBe('accounts.lane.grant_not_redeemed')
    }
  })

  // B2: darwin exercises the same gate/override decision win32 would, without win32's real
  // PowerShell DACL probe, which this Linux test host cannot satisfy — the same substitution
  // `principal-lanes-rpc.test.ts` makes for the identical reason. This arm is deliberately NOT
  // routed through the socket/wire harness above: B2's gate lives entirely in
  // `PrincipalLaneConsentService.provisionLane`, so a direct construction of that production
  // class (the same pattern `principal-lanes-rpc.test.ts` uses) is the real entry point for it.
  it('provisions on a gated platform only with the override, and records it on the audit row', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-production-wiring-gated-'))
    dirs.push(userDataPath)
    const hostConfigDir = mkdtempSync(join(tmpdir(), 'orca-lane-production-wiring-hostcfg-'))
    dirs.push(hostConfigDir)
    const grants = new FakeGrants()
    grants.add('ana-desktop')
    const gatedConsent = new PrincipalLaneConsentService(
      new PrincipalRegistry(userDataPath, grants),
      () => ({ hostConfigDir, hostConfigPath: join(userDataPath, '.claude.json') }),
      'darwin'
    )

    const ana = gatedConsent.createPrincipal(CONSENT, 'Ana')
    gatedConsent.bindGrant(CONSENT, 'ana-desktop', ana.principalId)
    gatedConsent.designatePusher(CONSENT, ana.principalId, 'ana-desktop')

    expect(() => gatedConsent.provisionLane(CONSENT, ana.principalId)).toThrowError(
      /not enabled on macOS yet/
    )

    const provisioned = gatedConsent.provisionLane(CONSENT, ana.principalId, {
      acceptUnverifiedPlatform: true
    })
    expect(provisioned.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)

    const provisionRow = gatedConsent
      .listAudit()
      .find((row) => row.action === 'provision' && row.principalId === ana.principalId)
    expect(provisionRow?.platformAcceptance).toBe('unverified-darwin')
  })
})
