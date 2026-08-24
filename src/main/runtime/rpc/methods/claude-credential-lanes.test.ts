import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../../../shared/claude-lane-watermark'
import { LaneCredentialCoordinator } from '../../../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../../../claude-accounts/principal-credential-lane'
import { attachLaneWireService, LaneWireService } from '../../lane-wire-service'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { CLAUDE_CREDENTIAL_LANE_METHODS } from './claude-credential-lanes'
import { LANE_DELEGATED_SWITCH_METHODS } from './lane-delegated-switch'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'
const ALL_METHODS: readonly RpcAnyMethod[] = [
  ...CLAUDE_CREDENTIAL_LANE_METHODS,
  ...LANE_DELEGATED_SWITCH_METHODS
]

const createdDirs: string[] = []

afterEach(() => {
  attachLaneWireService(null)
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function credentials(refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${refreshToken}`,
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    }
  })
}

function attachService() {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-rpc-'))
  createdDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
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
  const bindings = new Map<string, string>([
    ['device-a', LANE_A],
    ['phone-a', LANE_A],
    ['device-b', LANE_B]
  ])
  const service = new LaneWireService({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => (principalId === LANE_A ? 'device-a' : 'device-b')
    },
    coordinator,
    persistence,
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  attachLaneWireService(service)
  return {
    service,
    lanesRoot,
    laneCredentialsOnDisk: (laneId: string): string | null => {
      const path = join(lanesRoot, laneId, '.credentials.json')
      return existsSync(path) ? readFileSync(path, 'utf-8') : null
    }
  }
}

const cleanups = new Map<string, () => void>()
const runtimeStub = {
  registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
  cleanupSubscription: (id: string) => {
    cleanups.get(id)?.()
    cleanups.delete(id)
  }
} as unknown as OrcaRuntimeService

function call(name: string, params: unknown, ctx: Partial<RpcContext> = {}): Promise<unknown> {
  const found = ALL_METHODS.find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  const parsed = found.params ? found.params.parse(params) : undefined
  return Promise.resolve(found.handler(parsed, { runtime: runtimeStub, ...ctx } as RpcContext))
}

function subscribe(ctx: Partial<RpcContext>, emit: (frame: unknown) => void): Promise<void> {
  const found = ALL_METHODS.find((candidate) => candidate.name === 'accounts.lane.statusSubscribe')
  if (!found || !isStreamingMethod(found)) {
    throw new Error('Missing streaming method')
  }
  return found.handler(undefined, { runtime: runtimeStub, ...ctx } as RpcContext, emit)
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

function pushParams(refreshToken: string, basedOn: string | null = null): Record<string, unknown> {
  return {
    envelope: {
      credentialsJson: credentials(refreshToken),
      oauthAccountJson: JSON.stringify({ accountUuid: 'acct-1' }),
      displayName: 'Work'
    },
    basedOnRefreshTokenSha256: basedOn,
    delegation: { hostId: 'h', principalId: LANE_A, delegatedGrantId: 'device-a', since: 1 }
  }
}

describe('lane RPC surface', () => {
  it('refuses every lane method by name when lanes are not enabled on this host', async () => {
    attachLaneWireService(null)
    for (const [name, params] of [
      ['accounts.lane.push', pushParams('rt-1')],
      ['accounts.lane.pullRotated', { knownRefreshTokenSha256: null }],
      ['accounts.lane.clear', undefined],
      ['accounts.lane.status', undefined],
      ['accounts.lane.setDelegableAccounts', { accounts: [] }],
      ['accounts.lane.requestSwitch', { delegatedAccountId: 'token' }]
    ] as const) {
      expect(await refusalCode(() => call(name, params, { pairedDeviceId: 'device-a' }))).toBe(
        'accounts.lane.not_enabled'
      )
    }
  })

  it('routes a push to the caller lane and refuses an anonymous local socket', async () => {
    const harness = attachService()
    await call('accounts.lane.push', pushParams('rt-1'), { pairedDeviceId: 'device-a' })
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-1')
    expect(harness.laneCredentialsOnDisk(LANE_B)).toBeNull()
    expect(await refusalCode(() => call('accounts.lane.push', pushParams('rt-2'), {}))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })

  it('refuses a malformed push with its own code rather than a generic params error', async () => {
    attachService()
    expect(
      await refusalCode(() =>
        call('accounts.lane.push', { envelope: {} }, { pairedDeviceId: 'device-a' })
      )
    ).toBe('accounts.lane.push_malformed')
  })

  it('publishes ready, then a status frame when the lane changes, to that principal only', async () => {
    const harness = attachService()
    const framesA: unknown[] = []
    const framesB: unknown[] = []
    void subscribe({ pairedDeviceId: 'device-a', connectionId: 'conn-a' }, (frame) =>
      framesA.push(frame)
    )
    void subscribe({ pairedDeviceId: 'device-b', connectionId: 'conn-b' }, (frame) =>
      framesB.push(frame)
    )
    expect(framesA[0]).toMatchObject({ type: 'ready', status: { laneId: LANE_A } })
    await call('accounts.lane.push', pushParams('rt-1'), { pairedDeviceId: 'device-a' })
    expect(framesA.at(-1)).toMatchObject({ type: 'status', status: { laneState: 'loaded' } })
    expect(framesB).toHaveLength(1)
    expect(harness.service.stream.hasSubscriptionForGrant(LANE_A, 'device-a')).toBe(true)
  })

  it('ends a subscription through the runtime cleanup registry', async () => {
    const harness = attachService()
    const frames: { type?: string }[] = []
    const done = subscribe({ pairedDeviceId: 'device-a', connectionId: 'conn-a' }, (frame) =>
      frames.push(frame as { type?: string })
    )
    const subscriptionId = (frames[0] as { subscriptionId: string }).subscriptionId
    await call('accounts.lane.statusUnsubscribe', { subscriptionId })
    await done
    expect(frames.at(-1)).toEqual({ type: 'end' })
    expect(harness.service.stream.hasSubscriptionForGrant(LANE_A, 'device-a')).toBe(false)
  })

  it('lets only the designated grant write the delegable list, and mints opaque tokens', async () => {
    const harness = attachService()
    expect(
      await refusalCode(() =>
        call(
          'accounts.lane.setDelegableAccounts',
          { accounts: [{ clientRef: 'ref-1' }] },
          { pairedDeviceId: 'phone-a' }
        )
      )
    ).toBe('accounts.lane.push_not_delegated')
    const result = (await call(
      'accounts.lane.setDelegableAccounts',
      { accounts: [{ clientRef: 'ref-1', displayName: 'Work' }] },
      { pairedDeviceId: 'device-a' }
    )) as { delegable: { delegatedAccountId: string }[] }
    expect(result.delegable[0]?.delegatedAccountId).not.toBe('ref-1')
    expect(harness.service.delegation.getRow(LANE_A).delegable).toHaveLength(1)
  })

  it('carries a phone requestSwitch to the desktop, and refuses it when the desktop is away', async () => {
    const harness = attachService()
    const [account] = harness.service.delegation.setDelegableAccounts(LANE_A, [
      { clientRef: 'ref-1' }
    ])
    expect(
      await refusalCode(() =>
        call(
          'accounts.lane.requestSwitch',
          { delegatedAccountId: account?.delegatedAccountId },
          { pairedDeviceId: 'phone-a' }
        )
      )
    ).toBe('accounts.lane.desktop_unavailable')
    const desktopFrames: { type?: string }[] = []
    void subscribe({ pairedDeviceId: 'device-a', connectionId: 'conn-a' }, (frame) =>
      desktopFrames.push(frame as { type?: string })
    )
    const pending = (await call(
      'accounts.lane.requestSwitch',
      { delegatedAccountId: account?.delegatedAccountId },
      { pairedDeviceId: 'phone-a' }
    )) as { status: string }
    expect(pending.status).toBe('pending')
    expect(desktopFrames.at(-1)).toMatchObject({ type: 'switch-requested' })
  })

  it('returns nothing from pullRotated when the desktop already holds the lane sha', async () => {
    attachService()
    const pushed = (await call('accounts.lane.push', pushParams('rt-1'), {
      pairedDeviceId: 'device-a'
    })) as { refreshTokenSha256: string }
    expect(
      await call(
        'accounts.lane.pullRotated',
        { knownRefreshTokenSha256: pushed.refreshTokenSha256 },
        { pairedDeviceId: 'device-a' }
      )
    ).toEqual({ rotated: false })
  })
})
