import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { readLaneAccountIndex, writeLaneAccountIndex } from '../claude-accounts/lane-account-index'
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
    },
    // Plants one captured login the same shape B2/A4 leave: an indexed row over a marker-valid,
    // credentialed `<lane>/claude-accounts/<id>/auth` directory.
    plantLaneAccount: (
      laneId: string,
      laneAccountId: string,
      email: string,
      active: boolean
    ): void => {
      const accountsRoot = join(lanesRoot, laneId, 'claude-accounts')
      const authDir = join(accountsRoot, laneAccountId, 'auth')
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${laneAccountId}\n`, {
        mode: 0o600
      })
      writeFileSync(join(authDir, '.credentials.json'), credentials(`rt-${email}`), { mode: 0o600 })
      writeLaneAccountIndex(accountsRoot, [
        ...readLaneAccountIndex(accountsRoot),
        { laneAccountId, email, label: null, active, capturedAt: new Date().toISOString() }
      ])
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
 * `assertDelegatedPusher` and the watermark-freshness coverage below judged against. S9-L1 moves
 * `logout` to `lane-account-authority.test.ts` (routed through the lifecycle fence there); status
 * loses the delegable list.
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
    expect(await refusalCode(async () => authority.requireProvisionedLaneDir(LANE_A))).toBe(
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

  // §rpcs item 8: `accounts` projects the per-lane account store's INDEX, never a directory walk —
  // L2's already-merged `lane-login-client.ts` reads this field off the status frame.
  it("projects the lane account store onto accounts, never another lane's", () => {
    const { authority, plantLaneAccount } = makeHarness()
    plantLaneAccount(LANE_A, '11111111-1111-4111-8111-111111111111', 'a@x.com', true)
    plantLaneAccount(LANE_A, '22222222-2222-4222-8222-222222222222', 'b@x.com', false)
    plantLaneAccount(LANE_B, '33333333-3333-4333-8333-333333333333', 'other@x.com', true)

    const result = authority.status('device-a')

    expect(result.accounts).toEqual([
      {
        laneAccountId: '11111111-1111-4111-8111-111111111111',
        email: 'a@x.com',
        label: null,
        active: true
      },
      {
        laneAccountId: '22222222-2222-4222-8222-222222222222',
        email: 'b@x.com',
        label: null,
        active: false
      }
    ])
  })

  it('reports an empty accounts array, never a walk, for a lane with no login store yet', () => {
    const { authority } = makeHarness()
    expect(authority.status('device-a').accounts).toEqual([])
  })

  it('publishes laneWipePending on the status a lane wipe latched', () => {
    const { authority } = makeHarness()
    markLaneWipePending(LANE_A)

    expect(authority.status('device-a')).toMatchObject({
      laneState: 'absent',
      laneWipePending: true
    })
    // Never leaks onto the other lane's own status.
    expect(authority.status('device-b').laneWipePending).toBe(false)
  })
})
