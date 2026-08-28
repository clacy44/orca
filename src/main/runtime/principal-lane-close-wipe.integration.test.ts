import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { OrcaRuntimeService } from './orca-runtime'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'
import { getPrincipalLaneConsentService } from './principal-lane-consent-service'
import { deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

/**
 * S9-L1 (§modules C, the login model): the connection-CLOSE wipe this suite used to cover
 * (S9c's close arm) is DELETED — a socket closing is not a logout, and the residency window is
 * now login-until-logout rather than push-until-last-close (plan §7 question 12, flagged rather
 * than landed silently). The first test below now pins the OPPOSITE: closing every socket of a
 * principal's grants must NOT wipe their lane. The revoke arm is unchanged and still covered.
 */

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

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

/** Authenticates one socket. Called twice on one pairing URL = two sockets on ONE grant. */
async function authenticate(pairingUrl: string): Promise<WebSocket> {
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
  return ws
}

function closeAndSettle(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => setTimeout(resolve, 60))
    ws.close()
  })
}

describe("the principal's last connection close no longer wipes the lane (S9-L1)", () => {
  const servers: OrcaRuntimeRpcServer[] = []
  const sockets: WebSocket[] = []
  const dirs: string[] = []

  afterEach(async () => {
    attachLaneWireService(null)
    for (const ws of sockets.splice(0)) {
      ws.close()
    }
    await Promise.all(servers.splice(0).map((server) => server.stop()))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function startHarness() {
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({})
    } as never)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-close-wipe-'))
    dirs.push(userDataPath)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    const consent = getPrincipalLaneConsentService()
    if (!consent) {
      throw new Error('consent_surface_unattached')
    }
    // One offer at a time: the host keeps ONE pending offer.
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
    const desktop = mintGrant('ana-desktop')
    const desktopWs = await authenticate(desktop.pairingUrl)
    const phone = mintGrant('ana-phone')
    const phoneWs = await authenticate(phone.pairingUrl)
    const ben = mintGrant('ben-desktop')
    const benWs = await authenticate(ben.pairingUrl)
    sockets.push(desktopWs, phoneWs, benWs)

    const ana = consent.createPrincipal(CONSENT, 'Ana')
    const benPrincipal = consent.createPrincipal(CONSENT, 'Ben')
    consent.bindGrant(CONSENT, desktop.deviceId, ana.principalId)
    consent.bindGrant(CONSENT, phone.deviceId, ana.principalId)
    consent.bindGrant(CONSENT, ben.deviceId, benPrincipal.principalId)

    const lanesRoot = join(userDataPath, 'claude-lanes')
    for (const principalId of [ana.principalId, benPrincipal.principalId]) {
      provisionPrincipalLane(principalId, { lanesRoot, platform: 'linux' })
      writeFileSync(
        join(lanesRoot, principalId, '.credentials.json'),
        credentials(`rt-${principalId}`)
      )
    }
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    attachLaneWireService(
      new LaneWireService({
        principals: {
          principalOf: () => null,
          delegatedGrantIdOf: () => null
        },
        coordinator,
        platform: 'linux'
      })
    )
    return {
      server,
      ana,
      benPrincipal,
      desktop,
      phone,
      ben,
      desktopWs,
      phoneWs,
      benWs,
      laneDir: (principalId: string) => join(lanesRoot, principalId),
      isLoaded: (principalId: string) =>
        existsSync(join(lanesRoot, principalId, '.credentials.json'))
    }
  }

  it('leaves the lane loaded even after every socket of every grant of that principal closes', async () => {
    const harness = await startHarness()
    const secondDesktopWs = await authenticate(harness.desktop.pairingUrl)
    sockets.push(secondDesktopWs)

    await closeAndSettle(secondDesktopWs)
    expect(harness.isLoaded(harness.ana.principalId)).toBe(true)

    await closeAndSettle(harness.desktopWs)
    expect(harness.isLoaded(harness.ana.principalId)).toBe(true)

    // The principal's TRUE last close — under the old S9c behavior this wiped the lane. Under the
    // login model it must not: only an explicit logout, a revoke or a deprovision does.
    await closeAndSettle(harness.phoneWs)
    expect(harness.isLoaded(harness.ana.principalId)).toBe(true)
    expect(existsSync(harness.laneDir(harness.ana.principalId))).toBe(true)
    // Nobody else's lane moved either.
    expect(harness.isLoaded(harness.benPrincipal.principalId)).toBe(true)
  })

  it("removes the lane and the watermark only on the principal's last revoke", async () => {
    const harness = await startHarness()
    await harness.server.revokeRuntimeAccess(harness.desktop.deviceId)
    await new Promise((resolve) => setTimeout(resolve, 60))

    // One of two grants: the lane, its files and its watermark are untouched.
    expect(existsSync(harness.laneDir(harness.ana.principalId))).toBe(true)
    expect(harness.isLoaded(harness.ana.principalId)).toBe(true)

    await harness.server.revokeRuntimeAccess(harness.phone.deviceId)
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(existsSync(harness.laneDir(harness.ana.principalId))).toBe(false)
    // Ben's lane is untouched, because it was never his last grant.
    expect(existsSync(harness.laneDir(harness.benPrincipal.principalId))).toBe(true)
  })
})
