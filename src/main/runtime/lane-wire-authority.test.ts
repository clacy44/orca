import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { LaneDelegationDirectory } from './lane-delegation-directory'
import { LaneWireAuthority, type LaneSwitchGate } from './lane-wire-authority'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

// Far-future expiry on purpose: an expiring blob makes the pre-push sync try to ROTATE, which is
// the sync driver's own arm and not what these cases are about.
function credentials(refreshToken: string, expiresAt = Date.now() + 3_600_000): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `at-${refreshToken}`, refreshToken, expiresAt }
  })
}

function sha(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex')
}

function oauthAccount(accountUuid: string, email = 'ana@example.com'): string {
  return JSON.stringify({ accountUuid, emailAddress: email })
}

const createdUserDataDirs: string[] = []

afterEach(() => {
  for (const dir of createdUserDataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeHarness(options: { designatedGrantId?: string | null; provision?: string[] } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-wire-'))
  createdUserDataDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  for (const laneId of options.provision ?? [LANE_A, LANE_B]) {
    provisionPrincipalLane(laneId, { lanesRoot, platform: 'linux' })
  }
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
  let sharedCredentials: string | null = null
  const coordinator = new LaneCredentialCoordinator({
    persistence,
    sharedLane: {
      readCredentials: () => sharedCredentials,
      readOauthAccount: () => null
    },
    laneOptions: { lanesRoot, platform: 'linux' }
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
  const delegation = new LaneDelegationDirectory(persistence)
  const authority = new LaneWireAuthority({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => designations.get(principalId) ?? null,
      labelOf: (principalId) => `label:${principalId}`
    },
    coordinator,
    delegation,
    switchGate,
    platform: 'linux'
  })
  return {
    authority,
    coordinator,
    delegation,
    gateCalls,
    designations,
    bindings,
    userData,
    laneDir: (laneId: string) => join(lanesRoot, laneId),
    setSharedCredentials: (value: string | null) => {
      sharedCredentials = value
    },
    laneCredentialsOnDisk: (laneId: string): string | null => {
      const path = join(lanesRoot, laneId, '.credentials.json')
      return existsSync(path) ? readFileSync(path, 'utf-8') : null
    }
  }
}

function pushParams(
  refreshToken: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    envelope: {
      credentialsJson: credentials(refreshToken),
      oauthAccountJson: oauthAccount('acct-1'),
      displayName: 'Work'
    },
    basedOnRefreshTokenSha256: null,
    delegation: {
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'device-a',
      since: 1
    },
    ...overrides
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

describe('lane wire authority — push authorization', () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    harness = makeHarness()
  })

  it('writes into the caller principal lane and nowhere else', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-1')
    expect(harness.laneCredentialsOnDisk(LANE_B)).toBeNull()
  })

  it('derives the lane from the caller, never from a parameter', async () => {
    // A params-derived lane id is exactly what this refuses: the extra member is rejected.
    expect(
      await refusalCode(() =>
        harness.authority.push(
          'device-a',
          pushParams('rt-1', {
            laneId: LANE_B
          })
        )
      )
    ).toBe('accounts.lane.push_malformed')
    expect(harness.laneCredentialsOnDisk(LANE_B)).toBeNull()
  })

  it('ignores the delegation member naming another principal: the caller decides the lane', async () => {
    await harness.authority.push(
      'device-a',
      pushParams('rt-1', {
        delegation: {
          hostId: 'host-1',
          principalId: LANE_B,
          delegatedGrantId: 'device-b',
          since: 1
        }
      })
    )
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-1')
    expect(harness.laneCredentialsOnDisk(LANE_B)).toBeNull()
  })

  it('lets a second grant of the same principal reach the lane only as its designated pusher', async () => {
    expect(await refusalCode(() => harness.authority.push('device-a2', pushParams('rt-1')))).toBe(
      'accounts.lane.push_not_delegated'
    )
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
    harness.designations.set(LANE_A, 'device-a2')
    await harness.authority.push('device-a2', pushParams('rt-1'))
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-1')
  })

  it('refuses an anonymous caller and a grant bound to no principal, writing nothing', async () => {
    expect(await refusalCode(() => harness.authority.push(undefined, pushParams('rt-1')))).toBe(
      'accounts.lane.caller_unidentified'
    )
    expect(await refusalCode(() => harness.authority.push('device-x', pushParams('rt-1')))).toBe(
      'accounts.lane.push_not_delegated'
    )
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
  })

  it('refuses a principal with no designation at all', async () => {
    const noPusher = makeHarness({ designatedGrantId: null })
    expect(await refusalCode(() => noPusher.authority.push('device-a', pushParams('rt-1')))).toBe(
      'accounts.lane.no_pusher_designated'
    )
    expect(noPusher.laneCredentialsOnDisk(LANE_A)).toBeNull()
  })

  it('never auto-provisions: an unprovisioned lane is refused and no directory appears', async () => {
    rmSync(join(harness.userData, 'claude-lanes', LANE_A), { recursive: true, force: true })
    expect(await refusalCode(() => harness.authority.push('device-a', pushParams('rt-1')))).toBe(
      'accounts.lane.not_provisioned'
    )
  })
})

describe('lane wire authority — push ordering and freshness', () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    harness = makeHarness()
  })

  it('accepts two consecutive pushes because the push itself moves the watermark', async () => {
    const first = await harness.authority.push('device-a', pushParams('rt-1'))
    expect(first.refreshTokenSha256).toBe(sha('rt-1'))
    await harness.authority.push(
      'device-a',
      pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
    )
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-2')
  })

  it('refuses a stale push and leaves the lane byte-identical', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    const before = harness.laneCredentialsOnDisk(LANE_A)
    expect(
      await refusalCode(() =>
        harness.authority.push(
          'device-a',
          pushParams('rt-9', { basedOnRefreshTokenSha256: sha('nope') })
        )
      )
    ).toBe('accounts.lane.push_stale')
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBe(before)
  })

  it('refuses an account already resident in another lane', async () => {
    harness.designations.set(LANE_B, 'device-b')
    await harness.authority.push('device-a', pushParams('rt-1'))
    const intoB = {
      ...pushParams('rt-1'),
      delegation: {
        hostId: 'host-1',
        principalId: LANE_B,
        delegatedGrantId: 'device-b',
        since: 1
      }
    }
    expect(await refusalCode(() => harness.authority.push('device-b', intoB))).toBe(
      'accounts.lane.account_resident_elsewhere'
    )
    expect(harness.laneCredentialsOnDisk(LANE_B)).toBeNull()
  })

  it('refuses the account whose refresh token is live in an unmanaged shared lane', async () => {
    harness.setSharedCredentials(credentials('rt-1'))
    expect(await refusalCode(() => harness.authority.push('device-a', pushParams('rt-1')))).toBe(
      'accounts.lane.account_resident_elsewhere'
    )
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
  })

  it('takes the lane switch gate around the write and releases it on refusal', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    expect(harness.gateCalls).toEqual([`begin:${LANE_A}`, `end:${LANE_A}`])
    harness.gateCalls.length = 0
    await refusalCode(() =>
      harness.authority.push(
        'device-a',
        pushParams('rt-2', { basedOnRefreshTokenSha256: sha('nope') })
      )
    )
    // Refused before the write: the gate is never taken, so no spawn is blocked by a dead push.
    expect(harness.gateCalls).toEqual([])
  })

  it('runs the pre-push sync before the write, on the lane it is pushing', async () => {
    const syncLane = vi.spyOn(harness.coordinator, 'syncLane')
    await harness.authority.push('device-a', pushParams('rt-1'))
    expect(syncLane).toHaveBeenCalledWith(LANE_A, 'pre-push')
  })

  it('serializes two concurrent pushes to one lane rather than interleaving them', async () => {
    const results = await Promise.allSettled([
      harness.authority.push('device-a', pushParams('rt-1')),
      harness.authority.push(
        'device-a',
        pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
      )
    ])
    expect(results.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(harness.laneCredentialsOnDisk(LANE_A)).toContain('rt-2')
  })
})

describe('lane wire authority — pull, clear and status', () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    harness = makeHarness()
  })

  it('returns nothing when the desktop already holds the lane sha', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    expect(harness.authority.pullRotated('device-a', sha('rt-1'))).toEqual({ rotated: false })
  })

  it('returns the rotated blob when the lane moved underneath the desktop', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    writeFileSync(join(harness.laneDir(LANE_A), '.credentials.json'), credentials('rt-9'))
    const pulled = harness.authority.pullRotated('device-a', sha('rt-1'))
    expect(pulled).toMatchObject({ rotated: true, refreshTokenSha256: sha('rt-9') })
  })

  it('refuses a pull from a grant that is not the designated puller', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    expect(await refusalCode(async () => harness.authority.pullRotated('device-a2', null))).toBe(
      'accounts.lane.push_not_delegated'
    )
  })

  it('clears the caller own lane, keeps the watermark, and leaves another lane alone', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    await harness.authority.clear('device-a')
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
    expect(harness.coordinator.store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(sha('rt-1'))
    expect(harness.coordinator.store.getLaneState(LANE_A)).toBe('absent')
    // The release signal §2e's lease reads: the watermark and the designation both still stand.
    expect(harness.authority.status('device-a')).toMatchObject({
      delegationCleared: true,
      delegatedGrantId: 'device-a'
    })
  })

  it('un-marks the clear on the next push, so the lease is taken again', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    await harness.authority.clear('device-a')
    await harness.authority.push(
      'device-a',
      pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
    )
    expect(harness.authority.status('device-a').delegationCleared).toBe(false)
  })

  it('publishes the designation and the held name on status, and nothing about another lane', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    const status = harness.authority.status('device-a2')
    expect(status).toMatchObject({
      laneId: LANE_A,
      laneState: 'loaded',
      delegatedGrantId: 'device-a',
      callerIsDelegatedGrant: false,
      heldDisplayName: 'Work'
    })
    expect(harness.authority.status('device-b').laneState).toBe('absent')
  })

  it('refuses status, pull and clear for an anonymous caller', async () => {
    expect(await refusalCode(async () => harness.authority.status(undefined))).toBe(
      'accounts.lane.caller_unidentified'
    )
    expect(await refusalCode(async () => harness.authority.pullRotated(undefined, null))).toBe(
      'accounts.lane.caller_unidentified'
    )
    expect(await refusalCode(() => harness.authority.clear(undefined))).toBe(
      'accounts.lane.caller_unidentified'
    )
  })
})
