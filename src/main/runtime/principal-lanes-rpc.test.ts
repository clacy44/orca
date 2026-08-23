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

  add(deviceId: string): void {
    this.rows = [
      ...this.rows,
      {
        deviceId,
        name: 'Ana',
        token: `token-${deviceId}`,
        pairedAt: 1,
        lastSeenAt: 0,
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
    }
    expect(existsSync(join(state.userDataDir, 'claude-lanes', principalId))).toBe(false)
  })

  it('refuses provisioning for a principal with no designated pusher', async () => {
    grants.add('desktop')
    const { principalId } = (await call('accounts.lane.createPrincipal', {
      displayName: 'Ana'
    })) as { principalId: string }
    await call('accounts.lane.bindGrant', { deviceId: 'desktop', principalId })

    await expect(call('accounts.lane.provision', { principalId })).rejects.toThrow(
      /No grant has been designated/
    )
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
