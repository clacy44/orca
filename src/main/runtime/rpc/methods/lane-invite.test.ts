import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RpcAnyMethod, RpcContext, RpcMethod } from '../core'
import { PRINCIPAL_LANE_METHODS } from './principal-lanes'
import {
  attachPrincipalLaneConsentService,
  PrincipalLaneConsentService,
  type PairingInviteOfferArgs,
  type PairingInviteOfferResult
} from '../../principal-lane-consent-service'
import { PrincipalRegistry, type PrincipalGrantRow } from '../../principal-registry'

const state = { userDataDir: '' }

vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }))

// Why a fake, not the real DeviceRegistry: `mintInvite` only ever touches its `pairing` seam
// (`createPairingOffer` / `advertisedAddress`) and the grants source it reads back through —
// exercising the real registry's mint bookkeeping is `device-registry.test.ts`'s job.
class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true

  add(deviceId: string, lastSeenAt: number, pendingExpiresAt: number): void {
    this.rows = [
      ...this.rows,
      {
        deviceId,
        name: 'invitee',
        token: `token-${deviceId}`,
        pairedAt: 1,
        lastSeenAt,
        pendingExpiresAt
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

function methodByName(name: string): RpcMethod {
  const found = PRINCIPAL_LANE_METHODS.find((method: RpcAnyMethod) => method.name === name)
  if (!found || 'stream' in found) {
    throw new Error(`missing method ${name}`)
  }
  return found
}

async function call(
  name: string,
  params: unknown,
  ctx: Partial<RpcContext> = {}
): Promise<unknown> {
  const method = methodByName(name)
  const parsed = method.params ? method.params.parse(params) : undefined
  return await method.handler(parsed, ctx as RpcContext)
}

describe('accounts.lane.mintInvite', () => {
  let grants: FakeGrants
  let registry: PrincipalRegistry
  let offerCalls: PairingInviteOfferArgs[]
  let nextOfferResult: PairingInviteOfferResult

  beforeEach(() => {
    state.userDataDir = mkdtempSync(join(tmpdir(), 'orca-lane-invite-'))
    grants = new FakeGrants()
    registry = new PrincipalRegistry(state.userDataDir, grants)
    offerCalls = []
    nextOfferResult = { available: false, reason: 'unset', guidance: 'unset in this test' }
    const pairing = {
      createPairingOffer: (args: PairingInviteOfferArgs): PairingInviteOfferResult => {
        offerCalls.push(args)
        return nextOfferResult
      },
      advertisedAddress: () => 'example.com'
    }
    attachPrincipalLaneConsentService(
      new PrincipalLaneConsentService(
        registry,
        () => ({ hostConfigDir: 'unused', hostConfigPath: 'unused' }),
        'linux',
        pairing
      )
    )
  })

  afterEach(() => {
    attachPrincipalLaneConsentService(null)
    rmSync(state.userDataDir, { recursive: true, force: true })
  })

  it('mints a scoped, expiring invite and audits it with no token or URL', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana Ng'
    })) as { principalId: string }
    const deviceId = randomUUID()
    const expiresAt = Date.now() + 7_200_000
    grants.add(deviceId, 0, expiresAt)
    nextOfferResult = {
      available: true,
      pairingUrl: 'orca://pair?code=abc',
      endpoint: 'wss://example.com:6768',
      deviceId,
      webClientUrl: 'https://example.com/web-index.html#pairing=abc'
    }

    const result = (await call('accounts.lane.mintInvite', {
      principalId: principal.principalId,
      scope: 'runtime',
      accessProfile: 'full',
      ttlHours: 2
    })) as {
      deviceId: string
      deviceIdPrefix: string
      scope: string
      accessProfile: string
      expiresAt: number
      pairingUrl: string
    }

    expect(result.deviceId).toBe(deviceId)
    expect(result.deviceIdPrefix).toBe(deviceId.slice(0, 8))
    expect(result.scope).toBe('runtime')
    expect(result.accessProfile).toBe('full')
    expect(result.expiresAt).toBe(expiresAt)
    expect(offerCalls).toEqual([
      {
        address: 'example.com',
        name: 'Ana Ng',
        mint: 'always',
        scope: 'runtime',
        reach: 'network',
        accessProfile: 'full',
        ttlMs: 7_200_000
      }
    ])

    const row = registry.listAudit().find((entry) => entry.action === 'mint-invite')
    expect(row).toMatchObject({
      principalId: principal.principalId,
      deviceId,
      inviteScope: 'runtime',
      inviteExpiresAt: expiresAt
    })
    expect(JSON.stringify(registry.listAudit())).not.toContain('orca://pair')
  })

  it('omits ttlMs when --ttl is not given', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'Bea'
    })) as { principalId: string }
    const deviceId = randomUUID()
    grants.add(deviceId, 0, Date.now() + 86_400_000)
    nextOfferResult = {
      available: true,
      pairingUrl: 'orca://pair?code=x',
      endpoint: 'wss://e',
      deviceId,
      webClientUrl: null
    }
    await call('accounts.lane.mintInvite', {
      principalId: principal.principalId,
      accessProfile: 'full'
    })
    expect(offerCalls[0].ttlMs).toBeUndefined()
  })

  it('refuses an unknown person before any offer is created', async () => {
    await expect(
      call('accounts.lane.mintInvite', { principalId: randomUUID(), accessProfile: 'full' })
    ).rejects.toThrow(/no record of that person/)
    expect(offerCalls).toEqual([])
  })

  it('S10-19 W-6: refuses to mint when accessProfile is omitted — no default', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'NoProfile'
    })) as { principalId: string }
    await expect(
      call('accounts.lane.mintInvite', { principalId: principal.principalId })
    ).rejects.toThrow()
    expect(offerCalls).toEqual([])
  })

  it('propagates the offer guidance verbatim when pairing is unavailable', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'Cy'
    })) as { principalId: string }
    nextOfferResult = {
      available: false,
      reason: 'websocket_unavailable',
      guidance: 'WebSocket pairing is unavailable. Inspect preceding runtime errors.'
    }
    await expect(
      call('accounts.lane.mintInvite', {
        principalId: principal.principalId,
        accessProfile: 'full'
      })
    ).rejects.toThrow('WebSocket pairing is unavailable. Inspect preceding runtime errors.')
  })

  it('refuses over any identified socket; only the local caller (undefined clientKind) succeeds', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'Dee'
    })) as { principalId: string }
    const deviceId = randomUUID()
    grants.add(deviceId, 0, Date.now() + 60_000)
    nextOfferResult = {
      available: true,
      pairingUrl: 'orca://pair?code=x',
      endpoint: 'wss://e',
      deviceId,
      webClientUrl: null
    }
    for (const clientKind of ['mobile', 'runtime'] as const) {
      await expect(
        call(
          'accounts.lane.mintInvite',
          { principalId: principal.principalId, accessProfile: 'full' },
          { clientKind }
        )
      ).rejects.toThrow(/decisions made at the host machine/)
    }
    await expect(
      call('accounts.lane.mintInvite', {
        principalId: principal.principalId,
        accessProfile: 'full'
      })
    ).resolves.toBeTruthy()
  })

  it('rejects invalid scope and out-of-range ttl before minting', async () => {
    const principal = (await call('accounts.lane.createPrincipal', {
      displayName: 'Eve'
    })) as { principalId: string }
    await expect(
      call('accounts.lane.mintInvite', {
        principalId: principal.principalId,
        scope: 'desktop',
        accessProfile: 'full'
      })
    ).rejects.toThrow()
    await expect(
      call('accounts.lane.mintInvite', {
        principalId: principal.principalId,
        ttlHours: 0,
        accessProfile: 'full'
      })
    ).rejects.toThrow()
    await expect(
      call('accounts.lane.mintInvite', {
        principalId: principal.principalId,
        ttlHours: 25,
        accessProfile: 'full'
      })
    ).rejects.toThrow()
    expect(offerCalls).toEqual([])
  })
})
