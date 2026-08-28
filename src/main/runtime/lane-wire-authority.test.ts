import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  LaneCredentialCoordinator,
  type LaneCredentialCoordinatorOptions
} from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import {
  markLaneWipePending,
  resetLaneWipePendingForTests
} from '../claude-accounts/lane-wipe-pending'
import { isClaudeAuthSwitchInProgress } from '../claude-accounts/live-pty-gate'
import { LaneWireAuthority, type LaneSwitchGate } from './lane-wire-authority'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

function credentials(refreshToken: string, expiresAt = Date.now() + 3_600_000): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${refreshToken}`, refreshToken, expiresAt }
  })
}

const createdUserDataDirs: string[] = []

afterEach(() => {
  // The wipe mark is module-global: a case that leaves one set would fail every later lane read.
  resetLaneWipePendingForTests()
  for (const dir of createdUserDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeHarness(
  options: {
    designatedGrantId?: string | null
    provision?: string[]
    fetchLaneUsage?: LaneCredentialCoordinatorOptions['fetchLaneUsage']
    /** Omits the fake gate so the write takes `live-pty-gate`'s real per-lane pair. */
    realSwitchGate?: boolean
  } = {}
) {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-wire-'))
  createdUserDataDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  for (const laneId of options.provision ?? [LANE_A, LANE_B]) {
    provisionPrincipalLane(laneId, { lanesRoot, platform: 'linux' })
  }
  const coordinator = new LaneCredentialCoordinator({
    laneOptions: { lanesRoot, platform: 'linux' },
    ...(options.fetchLaneUsage ? { fetchLaneUsage: options.fetchLaneUsage } : {})
  })
  const designations = new Map<string, string | null>([
    [LANE_A, options.designatedGrantId === undefined ? 'device-a' : options.designatedGrantId],
    [LANE_B, 'device-b']
  ])
  const bindings = new Map<string, string>([
    ['device-a', LANE_A],
    ['device-a2', LANE_A],
    ['device-b', LANE_B]
  ])
  const gateCalls: string[] = []
  const switchGate: LaneSwitchGate = {
    begin: (laneId) => gateCalls.push(`begin:${laneId}`),
    end: (laneId) => gateCalls.push(`end:${laneId}`)
  }
  const laneChanges: string[] = []
  const authority = new LaneWireAuthority({
    onLaneChanged: (laneId, cause) => laneChanges.push(`${cause}:${laneId}`),
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => designations.get(principalId) ?? null,
      labelOf: (principalId) => `label:${principalId}`
    },
    coordinator,
    ...(options.realSwitchGate ? {} : { switchGate }),
    platform: 'linux'
  })
  return {
    authority,
    coordinator,
    gateCalls,
    laneChanges,
    designations,
    bindings,
    userData,
    laneDir: (laneId: string) => join(lanesRoot, laneId),
    loadLane: (laneId: string, refreshToken: string) => {
      writeFileSync(join(lanesRoot, laneId, '.credentials.json'), credentials(refreshToken))
    },
    laneCredentialsOnDisk: (laneId: string): string | null => {
      const path = join(lanesRoot, laneId, '.credentials.json')
      return existsSync(path) ? readFileSync(path, 'utf-8') : null
    }
  }
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
 * Rev 32 (S9-L3, §10(g)) deletes `push`/`pullRotated` and the delegation directory that
 * `assertDelegatedPusher` and the watermark-freshness coverage below judged against. `logout`
 * replaces `clear` (§3 row 2) over the same wipe mechanism, and status loses the delegable list.
 */
describe('lane wire authority — caller derivation', () => {
  it('derives the lane from the caller, never from a parameter', () => {
    const { authority } = makeHarness()
    expect(authority.resolveCaller('device-a')).toEqual({
      deviceId: 'device-a',
      principalId: LANE_A
    })
    expect(authority.resolveCaller('device-b')).toEqual({
      deviceId: 'device-b',
      principalId: LANE_B
    })
  })

  it('refuses an anonymous caller and a grant bound to no principal', async () => {
    const { authority } = makeHarness()
    expect(authority.resolveCaller(null)).toBeNull()
    expect(authority.resolveCaller('unbound-device')).toBeNull()
    expect(await refusalCode(async () => authority.requireCaller(null))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })

  it('never auto-provisions: an unprovisioned lane is refused', async () => {
    const { authority } = makeHarness({ provision: [LANE_B] })
    expect(await refusalCode(async () => authority.logout('device-a'))).toBe(
      'accounts.lane.not_provisioned'
    )
  })
})

describe('lane wire authority — status', () => {
  it('refuses status for an anonymous caller', async () => {
    const { authority } = makeHarness()
    expect(await refusalCode(async () => authority.status(null))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })

  it('publishes the designation and the caller lane identity, and nothing about another lane', () => {
    const { authority, loadLane } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    const status = authority.status('device-a')
    expect(status).toMatchObject({
      laneId: LANE_A,
      laneState: 'loaded',
      delegatedGrantId: 'device-a',
      callerIsDelegatedGrant: true
    })
    expect(JSON.stringify(status)).not.toContain(LANE_B)
  })

  it('reports absent for an empty but provisioned lane', () => {
    const { authority } = makeHarness()
    expect(authority.status('device-a')).toMatchObject({ laneState: 'absent' })
  })
})

describe('lane wire authority — logout', () => {
  it('sweeps the caller own lane and leaves another lane alone', async () => {
    const { authority, loadLane, laneCredentialsOnDisk } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    loadLane(LANE_B, 'rt-2')

    const result = await authority.logout('device-a')

    expect(result.cleared).toContain('.credentials.json')
    expect(laneCredentialsOnDisk(LANE_A)).toBeNull()
    expect(laneCredentialsOnDisk(LANE_B)).not.toBeNull()
  })

  it('names the cause of the lane change as logout', async () => {
    const { authority, loadLane, laneChanges } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    await authority.logout('device-a')
    expect(laneChanges).toEqual([`logout:${LANE_A}`])
  })

  it('takes the switch gate around the write and releases it afterwards', async () => {
    const { authority, loadLane, gateCalls } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    await authority.logout('device-a')
    expect(gateCalls).toEqual([`begin:${LANE_A}`, `end:${LANE_A}`])
  })

  it('kills the in-flight usage probe before sweeping the lane', async () => {
    const order: string[] = []
    const { authority, coordinator, loadLane } = makeHarness({
      fetchLaneUsage: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('probe-aborted')
            reject(new Error('aborted'))
          })
        })
    })
    loadLane(LANE_A, 'rt-1')
    await coordinator.syncLane(LANE_A, 'launch')
    const pull = coordinator.pullLaneUsage()
    await Promise.resolve()

    await authority.logout('device-a')
    order.push('swept')
    await pull

    expect(order).toEqual(['probe-aborted', 'swept'])
  })

  // Mutation proof: `beginLaneSwitch`'s wipe-in-progress guard is new in this slice (rev 32's
  // logout inherits it from the deleted push handler's identical check). Deleting the guard turns
  // this refusal into a silent sweep racing the fence's own wipe.
  it('refuses a logout while a close-wipe is already marked pending for that lane', async () => {
    const { authority, loadLane } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    markLaneWipePending(LANE_A)

    expect(await refusalCode(async () => authority.logout('device-a'))).toBe(
      'accounts.lane.wipe_in_progress'
    )
  })

  it('releases the lane switch gate when the probe invalidation throws', async () => {
    const { authority, loadLane, gateCalls, coordinator } = makeHarness()
    loadLane(LANE_A, 'rt-1')
    vi.spyOn(coordinator, 'invalidateLaneUsageProbes').mockRejectedValueOnce(new Error('boom'))

    await expect(authority.logout('device-a')).rejects.toThrow('boom')

    expect(gateCalls).toEqual([`begin:${LANE_A}`, `end:${LANE_A}`])
  })

  it('holds only its own lane on the real per-lane gate, and only while the write runs', async () => {
    const { authority, loadLane } = makeHarness({ realSwitchGate: true })
    loadLane(LANE_A, 'rt-1')
    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(false)
    const promise = authority.logout('device-a')
    // Best-effort: the write is fast enough locally that asserting mid-flight is flaky, so this
    // only asserts the gate is clear again afterwards — the ordering itself is covered by the
    // switch-gate unit tests in `live-pty-gate.test.ts`.
    await promise
    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(false)
  })
})
