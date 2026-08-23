import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import {
  LaneCredentialCoordinator,
  type LaneCredentialCoordinatorOptions
} from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { resetLaneWipePendingForTests } from '../claude-accounts/lane-wipe-pending'
import { LaneDelegationDirectory } from './lane-delegation-directory'
import {
  isClaudeAuthSwitchInProgress,
  SHARED_CLAUDE_LANE_KEY
} from '../claude-accounts/live-pty-gate'
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

function refreshTokenOnDisk(credentialsJson: string | null): string | null {
  return credentialsJson
    ? ((JSON.parse(credentialsJson) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth
        .refreshToken ?? null)
    : null
}

function sha(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex')
}

function oauthAccount(accountUuid: string, email = 'ana@example.com'): string {
  return JSON.stringify({ accountUuid, emailAddress: email })
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
    /** Omits the fake gate so the push takes `live-pty-gate`'s real per-lane pair. */
    realSwitchGate?: boolean
  } = {}
) {
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
  const delegation = new LaneDelegationDirectory(persistence)
  const laneChanges: string[] = []
  const authority = new LaneWireAuthority({
    onLaneChanged: (laneId, cause) => laneChanges.push(`${cause}:${laneId}`),
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => designations.get(principalId) ?? null,
      labelOf: (principalId) => `label:${principalId}`
    },
    coordinator,
    delegation,
    ...(options.realSwitchGate ? {} : { switchGate }),
    platform: 'linux'
  })
  return {
    authority,
    coordinator,
    delegation,
    gateCalls,
    laneChanges,
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

  // A pending phone request is settled WITHOUT a frame on a push and refused BY NAME on a clear,
  // so the cause has to reach the switch service — a clear leaves no timer to save the request.
  it('names the cause of every lane change, so a clear is not mistaken for a push', async () => {
    await harness.authority.push('device-a', pushParams('rt-1'))
    await harness.authority.clear('device-a')
    expect(harness.laneChanges).toEqual([`push:${LANE_A}`, `clear:${LANE_A}`])
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

/**
 * §2f/§2k's fence, the kill half: the probe is a live `claude` holding the lane's PRE-change
 * single-use refresh token, so a push or a wipe must end it before it replaces or sweeps the file.
 */
describe('LaneWireAuthority — the in-flight lane usage probe', () => {
  function probeHarness() {
    let announceProbe = (): void => {}
    const probeRunning = new Promise<void>((resolve) => {
      announceProbe = resolve
    })
    // What the lane's credential file held at the instant the probe was killed.
    const credentialsAtKill: (string | null)[] = []
    let readLaneCredentials = (): string | null => null
    const harness = makeHarness({
      fetchLaneUsage: ({ signal }) =>
        new Promise((resolve) => {
          announceProbe()
          signal.addEventListener(
            'abort',
            () => {
              credentialsAtKill.push(readLaneCredentials())
              resolve({
                provider: 'claude',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: 'aborted',
                status: 'error'
              })
            },
            { once: true }
          )
        })
    })
    readLaneCredentials = () => refreshTokenOnDisk(harness.laneCredentialsOnDisk(LANE_A))
    return { ...harness, probeRunning, credentialsAtKill }
  }

  it('kills the probe before a push replaces the credential it is holding', async () => {
    const harness = probeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    // The tick's own sync is what publishes the lane's attribution row the pull iterates.
    await harness.coordinator.syncLane(LANE_A, 'rate-limit-tick')
    const pull = harness.coordinator.pullLaneUsage()
    await harness.probeRunning

    await harness.authority.push(
      'device-a',
      pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
    )

    // Killed, and killed while the PRE-push blob was still on disk.
    expect(harness.credentialsAtKill).toEqual(['rt-1'])
    expect(refreshTokenOnDisk(harness.laneCredentialsOnDisk(LANE_A))).toBe('rt-2')
    const outcome = await pull
    expect(outcome.skipped).toEqual([{ laneId: LANE_A, reason: 'stale-probe' }])
  })

  it('kills the probe before a clear sweeps the lane', async () => {
    const harness = probeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    await harness.coordinator.syncLane(LANE_A, 'rate-limit-tick')
    const pull = harness.coordinator.pullLaneUsage()
    await harness.probeRunning

    await harness.authority.clear('device-a')

    expect(harness.credentialsAtKill).toEqual(['rt-1'])
    expect(harness.laneCredentialsOnDisk(LANE_A)).toBeNull()
    await pull
  })

  // Negative control: with no probe in flight the fence changes nothing about a push.
  it('pushes normally when no probe is running', async () => {
    const harness = probeHarness()

    await harness.authority.push('device-a', pushParams('rt-1'))

    expect(harness.credentialsAtKill).toEqual([])
    expect(refreshTokenOnDisk(harness.laneCredentialsOnDisk(LANE_A))).toBe('rt-1')
  })
})

/**
 * §2d/§2k — a lane's usage row survives no credential change. The PULL half evicts itself; the
 * statusline half is a different sink and is invalidated through the same seam, which is the only
 * feed a lane has on `win32` where no probe runs at all.
 */
describe('both usage feeds are invalidated by a credential change', () => {
  it('reports the pushed lane to the usage invalidation listener', async () => {
    const harness = makeHarness()
    const invalidated: string[] = []
    harness.coordinator.setLaneUsageInvalidationListener((laneId) => invalidated.push(laneId))

    await harness.authority.push('device-a', pushParams('rt-1'))

    expect(invalidated).toEqual([LANE_A])
  })

  it('reports the cleared lane to the usage invalidation listener', async () => {
    const harness = makeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    const invalidated: string[] = []
    harness.coordinator.setLaneUsageInvalidationListener((laneId) => invalidated.push(laneId))

    await harness.authority.clear('device-a')

    expect(invalidated).toEqual([LANE_A])
  })

  // Negative control: one lane's push must not blank the other developer's bar.
  it('reports only the lane that changed', async () => {
    const harness = makeHarness()
    const invalidated: string[] = []
    harness.coordinator.setLaneUsageInvalidationListener((laneId) => invalidated.push(laneId))

    await harness.authority.push('device-a', pushParams('rt-1'))

    expect(invalidated).not.toContain(LANE_B)
  })
})

// §5 S9c's gate arm at its own site: the push's default gate is the real per-lane pair, so the
// spawn paths reading `isClaudeAuthSwitchInProgress(laneId)` see lane A closed and lane B open.
describe('the push takes the real per-lane switch gate', () => {
  it('holds only its own lane, and only while the lane write runs', async () => {
    const harness = makeHarness({ realSwitchGate: true })
    const writer = harness.coordinator.store.writer
    const realWrite = writer.writeCredentials.bind(writer)
    let observed: Record<string, boolean> = {}
    vi.spyOn(writer, 'writeCredentials').mockImplementation(async (laneDir, credentialsJson) => {
      observed = {
        laneA: isClaudeAuthSwitchInProgress(LANE_A),
        laneB: isClaudeAuthSwitchInProgress(LANE_B),
        host: isClaudeAuthSwitchInProgress(SHARED_CLAUDE_LANE_KEY)
      }
      await realWrite(laneDir, credentialsJson)
    })

    await harness.authority.push('device-a', pushParams('rt-real-gate'))

    expect(observed).toEqual({ laneA: true, laneB: false, host: false })
    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(false)
  })
})

// §5 S9c: what the lane wire shows and accepts on either side of a lifecycle wipe.
describe('a lane the close-wipe emptied', () => {
  it('publishes laneWipePending while the wipe is marked, and absent afterwards', async () => {
    const harness = makeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    const marks: (boolean | undefined)[] = []
    vi.spyOn(harness.coordinator.residency, 'clearLaneRow').mockImplementation(() => {
      marks.push(harness.authority.status('device-a').laneWipePending)
    })

    await harness.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(marks).toEqual([true])
    const status = harness.authority.status('device-a')
    expect(status.laneState).toBe('absent')
    expect(status.laneWipePending).toBeUndefined()
    // The watermark is kept, so the row still names what the lane last held.
    expect(status.refreshTokenSha256).toBe(sha('rt-1'))
  })

  it('lets a re-push void a wipe that never confirmed the lane empty', async () => {
    const harness = makeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    // The probe cannot be confirmed dead, so the sweep never runs and the mark stays set.
    const fence = vi
      .spyOn(harness.coordinator, 'invalidateLaneUsageProbes')
      .mockRejectedValue(new Error('probe kill failed'))

    const outcome = await harness.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)
    expect(outcome.completed).toBe(false)
    expect(harness.authority.status('device-a').laneWipePending).toBe(true)
    fence.mockRestore()

    await harness.authority.push(
      'device-a',
      pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
    )

    // Without this the mark is a one-way latch: the lane's usage probe is skipped for the rest of
    // the process and its status publishes `laneWipePending` over a demonstrably loaded lane.
    const status = harness.authority.status('device-a')
    expect(status.laneWipePending).toBeUndefined()
    expect(status.laneState).toBe('loaded')
  })

  it('releases the lane switch gate when the probe invalidation throws', async () => {
    const harness = makeHarness({ realSwitchGate: true })
    const fence = vi
      .spyOn(harness.coordinator, 'invalidateLaneUsageProbes')
      .mockRejectedValue(new Error('probe kill failed'))

    await expect(harness.authority.push('device-a', pushParams('rt-1'))).rejects.toThrow(
      'probe kill failed'
    )
    // The gate is taken before the caller's `finally` can be entered, and `begin` throws on a lane
    // already gated — so a leak here refuses every spawn AND every push in this lane forever.
    expect(isClaudeAuthSwitchInProgress(LANE_A)).toBe(false)
    fence.mockRestore()

    await harness.authority.push('device-a', pushParams('rt-1'))

    expect(refreshTokenOnDisk(harness.laneCredentialsOnDisk(LANE_A))).toBe('rt-1')
  })

  it("accepts the reconnecting desktop's re-push and refuses its stale one", async () => {
    const harness = makeHarness()
    await harness.authority.push('device-a', pushParams('rt-1'))
    await harness.coordinator.lifecycle.wipeOnLastConnectionClose(LANE_A)

    expect(await refusalCode(() => harness.authority.push('device-a', pushParams('rt-old')))).toBe(
      'accounts.lane.push_stale'
    )
    await harness.authority.push(
      'device-a',
      pushParams('rt-2', { basedOnRefreshTokenSha256: sha('rt-1') })
    )

    expect(refreshTokenOnDisk(harness.laneCredentialsOnDisk(LANE_A))).toBe('rt-2')
    expect(harness.authority.status('device-a').laneState).toBe('loaded')
  })
})
