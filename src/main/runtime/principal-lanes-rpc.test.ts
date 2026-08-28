import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcAnyMethod, RpcContext, RpcMethod } from './rpc/core'
import { PRINCIPAL_LANE_METHODS } from './rpc/methods/principal-lanes'
import { ALL_RPC_METHODS } from './rpc/methods'
import {
  attachPrincipalLaneConsentService,
  PrincipalLaneConsentService
} from './principal-lane-consent-service'
import { PrincipalRegistry, type PrincipalGrantRow } from './principal-registry'

const state = { userDataDir: '' }

vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }))

class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true

  add(deviceId: string, lastSeenAt = 1): void {
    this.rows = [
      ...this.rows,
      {
        deviceId,
        name: 'Ana',
        token: `token-${deviceId}`,
        pairedAt: 1,
        // Redeemed by default (M1) — a test exercising the un-redeemed refusal passes 0.
        lastSeenAt,
        // Present because a bind requires the mint discriminator; its value is not a precondition.
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

describe('principal lane consent RPC', () => {
  let grants: FakeGrants
  let hostConfigDir = ''
  let hostConfigPath = ''

  beforeEach(() => {
    state.userDataDir = mkdtempSync(join(tmpdir(), 'orca-lane-rpc-'))
    hostConfigDir = join(state.userDataDir, 'host-claude')
    hostConfigPath = join(hostConfigDir, '.claude.json')
    mkdirSync(hostConfigDir, { recursive: true })
    writeFileSync(join(hostConfigDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-4' }))
    writeFileSync(hostConfigPath, JSON.stringify({ theme: 'dark' }))
    writeFileSync(join(hostConfigDir, 'CLAUDE.md'), '# house rules')
    grants = new FakeGrants()
    attachPrincipalLaneConsentService(
      new PrincipalLaneConsentService(new PrincipalRegistry(state.userDataDir, grants), () => ({
        hostConfigDir,
        hostConfigPath
      }))
    )
  })

  afterEach(() => {
    attachPrincipalLaneConsentService(null)
    rmSync(state.userDataDir, { recursive: true, force: true })
  })

  it('is registered on the runtime method table', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))

    for (const method of PRINCIPAL_LANE_METHODS) {
      expect(registered.has(method.name), `${method.name} must be registered`).toBe(true)
    }
  })

  it('refuses every consent write from an identified socket', async () => {
    grants.add('desktop')
    // Every mutator on the surface, including the two destructive ones (§2a rule (iii)).
    const principalId = (await call('accounts.lane.createPrincipal', { displayName: 'Ana' })) as {
      principalId: string
    }

    for (const clientKind of ['mobile', 'runtime'] as const) {
      await expect(
        call('accounts.lane.createPrincipal', { displayName: 'Mallory' }, { clientKind })
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call(
          'accounts.lane.bindGrant',
          { deviceId: 'desktop', principalId: principalId.principalId },
          { clientKind }
        )
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call('accounts.lane.unbindGrant', { deviceId: 'desktop' }, { clientKind })
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call(
          'accounts.lane.rebindGrant',
          { deviceId: 'desktop', principalId: principalId.principalId },
          { clientKind }
        )
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call(
          'accounts.lane.designatePusher',
          { principalId: principalId.principalId, deviceId: 'desktop' },
          { clientKind }
        )
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call(
          'accounts.lane.bindFederatedLink',
          { homePeerFingerprint: 'f'.repeat(64) },
          { clientKind }
        )
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call('accounts.lane.provision', { principalId: principalId.principalId }, { clientKind })
      ).rejects.toThrow(/decisions made at the host machine/)
      await expect(
        call('accounts.lane.deprovision', { principalId: principalId.principalId }, { clientKind })
      ).rejects.toThrow(/decisions made at the host machine/)
    }

    const listed = (await call('accounts.lane.listPrincipals', null)) as {
      principals: { principalId: string }[]
    }
    expect(listed.principals).toHaveLength(1)
  })

  it('serves the status and audit reads over the local socket, refusing an identified one', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })

    // The anonymous local caller reads the roster it just built.
    const status = (await call('accounts.lane.readStatus', null)) as {
      grants: {
        deviceId: string
        label: string
        boundPrincipalId: string | null
        designated: boolean
        redeemed: boolean
      }[]
      principals: {
        principalId: string
        laneState: string
        delegatedGrantId: string | null
        boundDeviceIds: string[]
      }[]
    }
    expect(status.grants).toEqual([
      {
        deviceId: 'desktop',
        label: 'Ana',
        perPerson: true,
        boundPrincipalId: principalId,
        designated: true,
        redeemed: true
      }
    ])
    expect(status.principals[0]).toMatchObject({
      principalId,
      laneState: 'absent',
      delegatedGrantId: 'desktop',
      boundDeviceIds: ['desktop']
    })

    const audit = (await call('accounts.lane.readAudit', null)) as { audit: { action: string }[] }
    expect(audit.audit.map((row) => row.action)).toEqual(['create-principal', 'bind', 'designate'])

    // The SAME reads over an identified remote transport are refused by the host — a roster is a
    // host-only fact, so the consent door closes on the read exactly as it does on a write.
    for (const clientKind of ['mobile', 'runtime'] as const) {
      await expect(call('accounts.lane.readStatus', null, { clientKind })).rejects.toThrow(
        /decisions made at the host machine/
      )
      await expect(call('accounts.lane.readAudit', null, { clientKind })).rejects.toThrow(
        /decisions made at the host machine/
      )
    }
  })

  it('binds, designates and provisions over the local socket', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }

    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })
    const provisioned = (await call('accounts.lane.provision', { principalId })) as {
      provenanceLabel: string
    }

    const laneDir = join(state.userDataDir, 'claude-lanes', principalId)
    expect(provisioned.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)
    const laneSettings = JSON.parse(
      readFileSync(join(laneDir, 'settings.json'), 'utf-8')
    ) as Record<string, unknown>
    expect(laneSettings.model, 'the lane mirrors the host config dir it was told to read').toBe(
      'claude-opus-4'
    )
    expect(JSON.stringify(laneSettings.hooks)).toMatch(/claude-hook/)
    expect(existsSync(join(laneDir, 'CLAUDE.md'))).toBe(true)
    const laneConfig = JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8')) as Record<
      string,
      unknown
    >
    expect(laneConfig.theme).toBe('dark')
    expect(laneConfig.oauthAccount).toBeNull()
  })

  // M1 (release-audit): a bind/designate naming an un-redeemed per-person invite refuses, so
  // whoever redeems it LATER cannot inherit a binding made before they ever opened it.
  it('refuses to bind or designate an un-redeemed per-person invite', async () => {
    grants.add('unredeemed', 0)
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }

    await expect(
      call('accounts.lane.bindGrant', { deviceId: 'unredeemed', principalId })
    ).rejects.toThrow(/has not been redeemed yet/)

    const status = (await call('accounts.lane.readStatus', null)) as {
      grants: { deviceId: string; redeemed: boolean }[]
    }
    expect(status.grants.find((row) => row.deviceId === 'unredeemed')?.redeemed).toBe(false)
  })

  it('refuses provisioning on a platform whose §6 gate has not been cleared', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })

    for (const platform of ['darwin', 'win32'] as const) {
      attachPrincipalLaneConsentService(
        new PrincipalLaneConsentService(
          new PrincipalRegistry(state.userDataDir, grants),
          () => ({ hostConfigDir, hostConfigPath }),
          platform
        )
      )

      await expect(call('accounts.lane.provision', { principalId })).rejects.toThrow(
        /not enabled on (macOS|Windows) yet/
      )
      await expect(call('accounts.lane.provision', { principalId })).rejects.toThrow(
        /--accept-unverified-platform/
      )
    }
    expect(existsSync(join(state.userDataDir, 'claude-lanes', principalId))).toBe(false)
  })

  // B2: the operator override provisions on a gated platform and records the acceptance.
  it('provisions on a gated platform with the override and records it in the audit row', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })

    // darwin, not win32: win32's actual provisioning runs a real PowerShell DACL probe past the
    // gate, which this Linux test host cannot satisfy — the gate/override decision under test is
    // platform-generic, and darwin's harden step is a plain chmod that runs anywhere.
    attachPrincipalLaneConsentService(
      new PrincipalLaneConsentService(
        new PrincipalRegistry(state.userDataDir, grants),
        () => ({ hostConfigDir, hostConfigPath }),
        'darwin'
      )
    )

    // Default (no flag) is still refused on the gated platform.
    await expect(call('accounts.lane.provision', { principalId })).rejects.toThrow(
      /not enabled on macOS yet/
    )

    const provisioned = (await call('accounts.lane.provision', {
      principalId,
      acceptUnverifiedPlatform: true
    })) as { provenanceLabel: string }
    expect(provisioned.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)
    expect(existsSync(join(state.userDataDir, 'claude-lanes', principalId))).toBe(true)

    const audit = (await call('accounts.lane.readAudit', null)) as {
      audit: { action: string; platformAcceptance?: string }[]
    }
    expect(audit.audit.at(-1)).toMatchObject({
      action: 'provision',
      platformAcceptance: 'unverified-darwin'
    })
  })

  it('records no platformAcceptance on a provision that needed no override', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })

    await call('accounts.lane.provision', { principalId })

    const audit = (await call('accounts.lane.readAudit', null)) as {
      audit: { action: string; platformAcceptance?: string }[]
    }
    const provisionRow = audit.audit.at(-1)
    expect(provisionRow?.action).toBe('provision')
    expect(provisionRow?.platformAcceptance).toBeUndefined()
  })

  it('refuses provisioning for a principal with no designated pusher', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })

    await expect(call('accounts.lane.provision', { principalId })).rejects.toThrow(
      /No device is designated to sign this lane/
    )
    expect(existsSync(join(state.userDataDir, 'claude-lanes', principalId))).toBe(false)
  })

  it('refuses a content refresh for a principal whose lane it cannot prove it owns', async () => {
    const service = new PrincipalLaneConsentService(
      new PrincipalRegistry(state.userDataDir, grants),
      () => ({ hostConfigDir, hostConfigPath })
    )
    const principalId = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

    // Called with anything but a provisioned lane, the mirror would create the directory and fill
    // it with the host's memory, agents and commands — no marker, no hardening.
    expect(() => service.refreshLaneContent(principalId)).toThrow(/could not prove/)
    expect(existsSync(join(state.userDataDir, 'claude-lanes', principalId))).toBe(false)
  })

  it('wipes the credential when a lane is deprovisioned', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })
    await call('accounts.lane.designatePusher', { principalId, deviceId: 'desktop' })
    await call('accounts.lane.provision', { principalId })
    const laneDir = join(state.userDataDir, 'claude-lanes', principalId)
    writeFileSync(join(laneDir, '.credentials.json'), '{"claudeAiOauth":{}}')

    const result = (await call('accounts.lane.deprovision', { principalId })) as {
      deprovisioned: boolean
    }

    expect(result.deprovisioned).toBe(true)
    expect(existsSync(laneDir)).toBe(false)
  })
})
