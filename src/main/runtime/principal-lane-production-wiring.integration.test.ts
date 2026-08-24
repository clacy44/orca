/**
 * Release-audit T2: the ONE end-to-end test that boots the PRODUCTION wiring path — real
 * `setLaneWireHostDependencies` + `attachPrincipalLaneHost` (the same call chain `index.ts` and
 * `OrcaRuntimeRpcServer.start()` use), never a hand-built `LaneWireService` — and drives the
 * whole day-one flow over a real socket: create-person → bind → designate → provision → a push
 * over the socket → the lane loaded → a lane-pinned spawn's env carrying `CLAUDE_CONFIG_DIR` →
 * the last socket close → the credential file gone.
 *
 * `lane-wire-composition.test.ts` (B1) and `principal-lane-close-wipe.integration.test.ts` (S9c)
 * each cover one half of this over their own harness; this is the one place both halves run
 * together through the real composition, so a regression that only breaks the WIRING between them
 * — not either class on its own — fails here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { prepareLaneLaunch } from '../claude-accounts/principal-lane-preparation'
import { paneLaneLaunchFor } from '../ipc/lane-pinned-spawn'
import { computeLaneLaunch, type LaneLaunchSpawnShape } from './lane-launch-computation'
import { OrcaRuntimeService } from './orca-runtime'
import { getLaneWireService } from './lane-wire-service'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import { getPrincipalLaneConsentService } from './principal-lane-consent-service'
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

/** One request, one correlated reply — good enough for this test's one-push-at-a-time flow. */
function request(
  session: PairedSession,
  method: string,
  params?: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = `req-${method}-${Date.now()}`
    const onMessage = (data: WebSocket.RawData): void => {
      const plaintext = decrypt(
        typeof data === 'string' ? data : data.toString('utf-8'),
        session.sharedKey
      )
      if (!plaintext) {
        return
      }
      const response = JSON.parse(plaintext) as Record<string, unknown>
      if (response.id !== id) {
        return
      }
      session.ws.off('message', onMessage)
      resolve(response)
    }
    session.ws.on('message', onMessage)
    session.ws.send(
      encrypt(
        JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }),
        session.sharedKey
      )
    )
  })
}

function closeAndSettle(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => setTimeout(resolve, 60))
    ws.close()
  })
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

  it(
    'create-person, bind, designate, provision, push over the socket, lane loaded, ' +
      'a lane-pinned spawn env, then last-close wipe — all through the production wire',
    async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-production-wiring-'))
      electronState.userDataPath = userDataPath
      dirs.push(userDataPath)
      const lanesRoot = join(userDataPath, 'claude-lanes')

      // The exact dependency-registration `index.ts` performs before any registry exists (B1/B3).
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
      expect(getLaneWireService()).not.toBeNull()

      const consent = getPrincipalLaneConsentService()
      if (!consent) {
        throw new Error('consent_surface_unattached')
      }

      // A per-person invite, redeemed by the real E2EE handshake BEFORE any bind (M1's precondition).
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
      sockets.push(desktop.ws)

      // create-person -> bind -> designate -> provision, through the production consent service —
      // the same object every `accounts.lane.*` host-only RPC and the CLI forward into.
      const ana = consent.createPrincipal(CONSENT, 'Ana')
      consent.bindGrant(CONSENT, offer.deviceId, ana.principalId)
      consent.designatePusher(CONSENT, ana.principalId, offer.deviceId)
      // B2's override is exercised on the gated platforms directly in principal-lanes-rpc.test.ts;
      // this host runs the suite on linux, which is never gated, so no flag is needed here.
      const lane = consent.provisionLane(CONSENT, ana.principalId)
      expect(lane.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)
      expect(existsSync(join(lanesRoot, ana.principalId))).toBe(true)

      // The desktop push client's own act: a credential envelope pushed over the paired socket,
      // landing through the production LaneWireService's authority — not a hand-built one.
      const pushed = await request(desktop, 'accounts.lane.push', {
        envelope: {
          credentialsJson: credentials('rt-ana-1'),
          oauthAccountJson: JSON.stringify({
            accountUuid: 'acct-uuid-ana',
            emailAddress: 'ana@corp.test'
          }),
          displayName: 'Ana work'
        },
        basedOnRefreshTokenSha256: null,
        delegation: {
          hostId: 'host-1',
          principalId: ana.principalId,
          delegatedGrantId: offer.deviceId,
          since: 1
        }
      })
      expect(pushed.result).toMatchObject({ laneState: 'loaded' })

      const laneDir = join(lanesRoot, ana.principalId)
      const credentialPath = join(laneDir, '.credentials.json')
      expect(existsSync(credentialPath)).toBe(true)
      expect(readFileSync(credentialPath, 'utf-8')).toContain('rt-ana-1')

      // A lane-pinned spawn's env carries this principal's CLAUDE_CONFIG_DIR — the same
      // preparation + computation the PTY spawn anchor runs, over the lane the push just loaded.
      const preparation = prepareLaneLaunch({
        principalId: ana.principalId,
        lanesRoot,
        platform: 'linux'
      })
      expect(preparation.envPatch?.CLAUDE_CONFIG_DIR).toBe(laneDir)
      const paneLane = paneLaneLaunchFor({
        lanePrincipalId: ana.principalId,
        envPatch: preparation.envPatch
      })
      const spawnOptions: LaneLaunchSpawnShape = { env: { PATH: '/usr/bin' } }
      const computed = computeLaneLaunch(paneLane, spawnOptions)
      expect(computed.spawnOptions.env?.CLAUDE_CONFIG_DIR).toBe(laneDir)
      expect(computed.spawnOptions.credentialLane).toEqual({ principalId: ana.principalId })

      // The last socket close: the wipe hook the server arms on the production `principalGrantBindings`.
      await closeAndSettle(desktop.ws)
      expect(existsSync(credentialPath)).toBe(false)
      // The watermark (and the lane directory) survive the wipe, same as the close-wipe suite.
      expect(watermarks.some((row) => row.laneId === ana.principalId)).toBe(true)
      expect(existsSync(laneDir)).toBe(true)
    }
  )
})
