import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../../../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../../../claude-accounts/principal-credential-lane'
import { attachLaneWireService, LaneWireService } from '../../lane-wire-service'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { isStreamingMethod, type RpcContext } from '../core'
import { CLAUDE_CREDENTIAL_LANE_METHODS } from './claude-credential-lanes'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

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
  const coordinator = new LaneCredentialCoordinator({
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
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  attachLaneWireService(service)
  return {
    service,
    lanesRoot,
    loadLane: (laneId: string, refreshToken: string): void => {
      writeFileSync(join(lanesRoot, laneId, '.credentials.json'), credentials(refreshToken))
    },
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
  const found = CLAUDE_CREDENTIAL_LANE_METHODS.find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  const parsed = found.params ? found.params.parse(params) : undefined
  return Promise.resolve(found.handler(parsed, { runtime: runtimeStub, ...ctx } as RpcContext))
}

function subscribe(ctx: Partial<RpcContext>, emit: (frame: unknown) => void): Promise<void> {
  const found = CLAUDE_CREDENTIAL_LANE_METHODS.find(
    (candidate) => candidate.name === 'accounts.lane.statusSubscribe'
  )
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

/**
 * Rev 32 (S9-L3, §10(g)) deletes `push`/`pullRotated`/`setDelegableAccounts` and the
 * `requestSwitch` RPC entirely; `logout` replaces `clear` (§3 row 2). S9-L1's login quartet and
 * `selectAccount`/`removeAccount` are not yet wired into this tree's host RPC surface.
 */
describe('lane RPC surface', () => {
  it('refuses every lane method by name when lanes are not enabled on this host', async () => {
    attachLaneWireService(null)
    for (const [name, params] of [
      ['accounts.lane.logout', undefined],
      ['accounts.lane.status', undefined]
    ] as const) {
      expect(await refusalCode(() => call(name, params, { pairedDeviceId: 'device-a' }))).toBe(
        'accounts.lane.not_enabled'
      )
    }
  })

  it('derives the lane from the caller and refuses an anonymous local socket', async () => {
    const harness = attachService()
    harness.loadLane(LANE_A, 'rt-1')
    const status = (await call('accounts.lane.status', undefined, {
      pairedDeviceId: 'device-a'
    })) as { laneId: string }
    expect(status.laneId).toBe(LANE_A)
    expect(await refusalCode(() => call('accounts.lane.status', undefined, {}))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })

  it('publishes ready, then a status frame when the lane changes, to that principal only', async () => {
    const harness = attachService()
    harness.loadLane(LANE_A, 'rt-1')
    const framesA: unknown[] = []
    const framesB: unknown[] = []
    void subscribe({ pairedDeviceId: 'device-a', connectionId: 'conn-a' }, (frame) =>
      framesA.push(frame)
    )
    void subscribe({ pairedDeviceId: 'device-b', connectionId: 'conn-b' }, (frame) =>
      framesB.push(frame)
    )
    expect(framesA[0]).toMatchObject({ type: 'ready', status: { laneId: LANE_A } })
    await call('accounts.lane.logout', undefined, { pairedDeviceId: 'device-a' })
    expect(framesA.at(-1)).toMatchObject({ type: 'status', status: { laneState: 'absent' } })
    expect(framesB).toHaveLength(1)
  })

  it('ends a subscription through the runtime cleanup registry', async () => {
    const harness = attachService()
    harness.loadLane(LANE_A, 'rt-1')
    const frames: { type?: string }[] = []
    const done = subscribe({ pairedDeviceId: 'device-a', connectionId: 'conn-a' }, (frame) =>
      frames.push(frame as { type?: string })
    )
    const subscriptionId = (frames[0] as { subscriptionId: string }).subscriptionId
    await call('accounts.lane.statusUnsubscribe', { subscriptionId })
    await done
    expect(frames.at(-1)).toEqual({ type: 'end' })
  })

  it('logs the caller own lane out and leaves another lane alone', async () => {
    const harness = attachService()
    harness.loadLane(LANE_A, 'rt-1')
    harness.loadLane(LANE_B, 'rt-2')
    await call('accounts.lane.logout', undefined, { pairedDeviceId: 'device-a' })
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
    expect(harness.laneCredentialsOnDisk(LANE_B)).not.toBeNull()
  })

  it('refuses logout for an anonymous local socket', async () => {
    attachService()
    expect(await refusalCode(() => call('accounts.lane.logout', undefined, {}))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })
})
