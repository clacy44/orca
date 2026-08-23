import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { AccountResidencyIndex } from './account-residency-index'
import { hashRefreshToken } from './claude-credential-identity'
import { LaneAuthState, laneAccountKey } from './lane-auth-state'
import { PrincipalLaneStore } from './principal-lane-store'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'
const ACCOUNT_X = 'account-x'
const ACCOUNT_Y = 'account-y'

const credentials = (refreshToken: string, expiresAt = 0): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt } })

/** Rotation reads the lane before it spends the token, so every fixture must load the lane. */
const seedLane = (lanesRoot: string, laneId: string, credentialsJson: string): void => {
  writeFileSync(join(lanesRoot, laneId, '.credentials.json'), credentialsJson, { mode: 0o600 })
}

describe('lane auth state', () => {
  let userData = ''
  let lanesRoot = ''
  let store: PrincipalLaneStore
  let residency: AccountResidencyIndex
  let laneLivePtys: Set<string>
  let unattributedLivePtys: boolean

  const rows: ClaudeLaneCredentialWatermark[] = []
  const persistence = {
    getClaudeLaneCredentialWatermarks: () => rows.slice(),
    setClaudeLaneCredentialWatermarks: (next: readonly ClaudeLaneCredentialWatermark[]) => {
      rows.length = 0
      rows.push(...next)
    }
  }

  const makeState = (
    refreshCredentials: (credentialsJson: string) => Promise<string | null>
  ): LaneAuthState =>
    new LaneAuthState({
      store,
      residency,
      refreshCredentials,
      laneHasLivePtys: (laneId) => laneLivePtys.has(laneId),
      hasUnattributedLivePtys: () => unattributedLivePtys,
      isExpiring: () => true
    })

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-auth-'))
    lanesRoot = join(userData, 'claude-lanes')
    rows.length = 0
    laneLivePtys = new Set()
    unattributedLivePtys = false
    store = new PrincipalLaneStore(persistence, { lanesRoot, platform: 'linux' })
    residency = new AccountResidencyIndex({
      sharedLane: { readCredentials: () => null, readOauthAccount: () => null }
    })
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
    provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('defers the rotation of the account the live lane holds, and not another account', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    seedLane(lanesRoot, LANE_B, credentials('rt-y'))
    residency.setLaneRow(LANE_A, credentials('rt-x'), { accountUuid: ACCOUNT_X })
    residency.setLaneRow(LANE_B, credentials('rt-y'), { accountUuid: ACCOUNT_Y })
    laneLivePtys.add(LANE_A)
    const authState = makeState(async () => credentials('rt-rotated'))
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'deferred' })
    // Negative control: the other account's rotation is not deferred by A's live pty.
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_B,
        accountUuid: ACCOUNT_Y,
        refreshTokenSha256: hashRefreshToken('rt-y'),
        credentialsJson: credentials('rt-y')
      })
    ).resolves.toMatchObject({ status: 'rotated' })
    expect(authState.getState(LANE_A, ACCOUNT_X).refreshDeferredByLivePtyAccountUuid).toBe(
      ACCOUNT_X
    )
    expect(authState.getState(LANE_B, ACCOUNT_Y).refreshDeferredByLivePtyAccountUuid).toBeNull()
  })

  it('over-defers while any live pty is unattributed', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    residency.setLaneRow(LANE_A, credentials('rt-x'), { accountUuid: ACCOUNT_X })
    unattributedLivePtys = true
    const authState = makeState(async () => credentials('rt-rotated'))
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'deferred' })
  })

  it('persists a rotation into the lane file and nowhere else', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    const authState = makeState(async () => credentials('rt-rotated'))
    await authState.rotateLaneCredentials({
      laneId: LANE_A,
      accountUuid: ACCOUNT_X,
      refreshTokenSha256: hashRefreshToken('rt-x'),
      credentialsJson: credentials('rt-x')
    })
    expect(readFileSync(join(lanesRoot, LANE_A, '.credentials.json'), 'utf-8')).toContain(
      'rt-rotated'
    )
    expect(store.readLaneCredentials(LANE_B)).toBeNull()
  })

  it('spends nothing when the lane went away before the call', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    const refresh = vi.fn(async () => credentials('rt-rotated'))
    const authState = makeState(refresh)
    rmSync(join(lanesRoot, LANE_A), { recursive: true, force: true })
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'lane-unavailable' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('spends nothing on a blob the lane has already moved past', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-newer'))
    const refresh = vi.fn(async () => credentials('rt-rotated'))
    const authState = makeState(refresh)
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'input-superseded' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reports a spent token the lane could not receive, and refuses the replay it enables', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x', 1_000))
    store.recordSyncedLaneCredentials(LANE_A, credentials('rt-x', 1_000))
    const refresh = vi.fn(async () => {
      // The close-wipe lands during the token round trip, which is a real network call.
      rmSync(join(lanesRoot, LANE_A), { recursive: true, force: true })
      return credentials('rt-rotated', 5_000)
    })
    const authState = makeState(refresh)
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x', 1_000)
      })
    ).resolves.toEqual({
      status: 'lane-write-lost',
      credentialsJson: credentials('rt-rotated', 5_000)
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    // The watermark moved to the SPENT token's successor, so the desktop's cached copy is stale.
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-rotated'))
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-x', 1_000),
        basedOnRefreshTokenSha256: hashRefreshToken('rt-x')
      })
    ).toThrow(/older than what this host already holds/)
  })

  it('refuses to treat a malformed refresh response as a rotation', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    const authState = makeState(async () =>
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })
    )
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'refresh-failed' })
    expect(store.readLaneCredentials(LANE_A)).toBe(credentials('rt-x'))
  })

  it('does not rotate a credential that is not expiring', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-x'))
    const refresh = vi.fn(async () => credentials('rt-rotated'))
    const authState = new LaneAuthState({
      store,
      residency,
      refreshCredentials: refresh,
      laneHasLivePtys: () => false,
      hasUnattributedLivePtys: () => false,
      isExpiring: () => false
    })
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-x'),
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'not-expiring' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not let a slow write in one lane delay another lane', async () => {
    const authState = makeState(async () => credentials('rt'))
    const order: string[] = []
    let releaseA = (): void => {}
    const blockedA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const laneA = authState.serializeLaneWrite(LANE_A, async () => {
      await blockedA
      order.push('a')
    })
    const laneB = authState.serializeLaneWrite(LANE_B, async () => {
      order.push('b')
    })
    await laneB
    expect(order).toEqual(['b'])
    releaseA()
    await laneA
    expect(order).toEqual(['b', 'a'])
  })

  it('serializes two lanes rotating the same account, one after the other', async () => {
    seedLane(lanesRoot, LANE_A, credentials('rt-1'))
    seedLane(lanesRoot, LANE_B, credentials('rt-2'))
    const active: string[] = []
    const seen: string[] = []
    const authState = makeState(async (credentialsJson) => {
      seen.push(credentialsJson)
      active.push(credentialsJson)
      expect(active).toHaveLength(1)
      await Promise.resolve()
      active.pop()
      return credentials('rt-rotated')
    })
    await Promise.all([
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-1'),
        credentialsJson: credentials('rt-1')
      }),
      authState.rotateLaneCredentials({
        laneId: LANE_B,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: hashRefreshToken('rt-2'),
        credentialsJson: credentials('rt-2')
      })
    ])
    expect(active).toEqual([])
    // The queue is only proved by a refresh that actually ran in both lanes.
    expect(seen).toEqual([credentials('rt-1'), credentials('rt-2')])
  })

  it('keys its rows by lane AND account, so no lane reads another one row', () => {
    const authState = makeState(async () => null)
    authState.getState(LANE_A, ACCOUNT_X).lastWrittenOauthAccount = { accountUuid: ACCOUNT_X }
    expect(authState.getState(LANE_B, ACCOUNT_X).lastWrittenOauthAccount).toBeNull()
    expect(authState.getState(LANE_A, ACCOUNT_Y).lastWrittenOauthAccount).toBeNull()
    expect(authState.getState(LANE_A, null).lastWrittenOauthAccount).toBeNull()
    authState.forgetLane(LANE_A)
    expect(authState.getState(LANE_A, ACCOUNT_X).lastWrittenOauthAccount).toBeNull()
    expect(laneAccountKey(LANE_A, ACCOUNT_X)).not.toBe(laneAccountKey(LANE_B, ACCOUNT_X))
  })
})
