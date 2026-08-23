import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { AccountResidencyIndex } from './account-residency-index'
import { hashRefreshToken } from './claude-credential-identity'
import { LaneAuthState } from './lane-auth-state'
import { LaneSyncDriver } from './lane-sync-driver'
import { PrincipalLaneStore, type LaneRotationReceipt } from './principal-lane-store'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ACCOUNT_X = 'account-x'

const credentials = (refreshToken: string, expiresAt = 0): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt } })

describe('lane sync driver', () => {
  let userData = ''
  let lanesRoot = ''
  let store: PrincipalLaneStore
  let residency: AccountResidencyIndex
  let authState: LaneAuthState
  let driver: LaneSyncDriver
  let refresh: ReturnType<typeof vi.fn>
  let laneLivePtys: Set<string>
  let receipts: LaneRotationReceipt[]

  const rows: ClaudeLaneCredentialWatermark[] = []
  const persistence = {
    getClaudeLaneCredentialWatermarks: () => rows.slice(),
    setClaudeLaneCredentialWatermarks: (next: readonly ClaudeLaneCredentialWatermark[]) => {
      rows.length = 0
      rows.push(...next)
    }
  }

  const putLaneFiles = (refreshToken: string, expiresAt = 0): void => {
    writeFileSync(
      join(lanesRoot, LANE_A, '.credentials.json'),
      credentials(refreshToken, expiresAt)
    )
    writeFileSync(
      join(lanesRoot, LANE_A, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_X, emailAddress: 'x@example.com' } })
    )
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-sync-'))
    lanesRoot = join(userData, 'claude-lanes')
    rows.length = 0
    receipts = []
    laneLivePtys = new Set()
    refresh = vi.fn(async () => credentials('rt-rotated', 9_000))
    store = new PrincipalLaneStore(persistence, { lanesRoot, platform: 'linux' })
    residency = new AccountResidencyIndex({
      sharedLane: { readCredentials: () => null, readOauthAccount: () => null }
    })
    authState = new LaneAuthState({
      store,
      residency,
      refreshCredentials: refresh as unknown as (json: string) => Promise<string | null>,
      laneHasLivePtys: (laneId) => laneLivePtys.has(laneId),
      hasUnattributedLivePtys: () => false,
      isExpiring: () => true
    })
    driver = new LaneSyncDriver({ store, residency, authState })
    store.onRotationReceipt((receipt) => receipts.push(receipt))
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('never rotates on the startup pass, however expiring the credential is', async () => {
    putLaneFiles('rt-1')
    const outcome = await driver.syncLane(LANE_A, 'startup')
    expect(outcome.rotated).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(store.readLaneCredentials(LANE_A)).toContain('rt-1')
    // It still OBSERVES: the watermark moves and the residency row is derived.
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-1'))
    expect(residency.getLaneRowKeys(LANE_A)?.accountUuid).toBe(ACCOUNT_X)
  })

  it('rotates on a launch, which is the same lane in the same state', async () => {
    putLaneFiles('rt-1')
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.rotated).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(store.readLaneCredentials(LANE_A)).toContain('rt-rotated')
    expect(receipts.map((receipt) => receipt.cause)).toEqual(['host'])
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-rotated'))
  })

  it('emits a cli-observed receipt when the lane rotated out of band', async () => {
    putLaneFiles('rt-1')
    store.recordPushedLaneCredentials(LANE_A, credentials('rt-1'), {
      accountUuid: ACCOUNT_X
    })
    receipts = []
    // The lane's own claude rotated the single-use token behind Orca's back.
    putLaneFiles('rt-cli')
    laneLivePtys.add(LANE_A)
    residency.setLaneRow(LANE_A, credentials('rt-cli'), { accountUuid: ACCOUNT_X })
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.observedForeignChange).toBe(true)
    expect(receipts.map((receipt) => receipt.cause)).toEqual(['cli-observed'])
    expect(receipts[0]?.identity.accountUuid).toBe(ACCOUNT_X)
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-cli'))
    // A replay of the pre-rotation push is now refused against the moved watermark.
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-1'),
        basedOnRefreshTokenSha256: hashRefreshToken('rt-1')
      })
    ).toThrow(/older than what this host already holds/)
  })

  it('does not call a lane rotation an out-of-band one', async () => {
    putLaneFiles('rt-1')
    await driver.syncLane(LANE_A, 'launch')
    receipts = []
    // Negative control: the second sync sees what OUR rotation wrote, not a foreign change.
    const outcome = await driver.syncLane(LANE_A, 'rate-limit-tick')
    expect(outcome.observedForeignChange).toBe(false)
  })

  it('reports a lane whose foreign-rotated token can no longer refresh as reauth-required', async () => {
    putLaneFiles('rt-1')
    store.recordPushedLaneCredentials(LANE_A, credentials('rt-1'), { accountUuid: ACCOUNT_X })
    putLaneFiles('rt-foreign')
    refresh.mockResolvedValue(null)
    receipts = []
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.rotated).toBe(false)
    expect(receipts.map((receipt) => receipt.cause)).toEqual(['cli-observed', 'foreign-rotation'])
    expect(outcome.laneState).toBe('reauth-required')
    expect(store.getLaneState(LANE_A)).toBe('reauth-required')
  })

  it('keeps a transient refresh failure out of the reauth-required state', async () => {
    putLaneFiles('rt-1')
    store.recordPushedLaneCredentials(LANE_A, credentials('rt-1'), { accountUuid: ACCOUNT_X })
    refresh.mockResolvedValue(null)
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.observedForeignChange).toBe(false)
    expect(receipts).toEqual([])
    expect(outcome.laneState).toBe('loaded')
  })

  it('defers rotation while a pty in that lane holds the credential', async () => {
    putLaneFiles('rt-1')
    residency.setLaneRow(LANE_A, credentials('rt-1'), { accountUuid: ACCOUNT_X })
    laneLivePtys.add(LANE_A)
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.rotated).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(store.readLaneCredentials(LANE_A)).toContain('rt-1')
  })

  it('clears the residency row for a lane holding no credential', async () => {
    putLaneFiles('rt-1')
    await driver.syncLane(LANE_A, 'startup')
    expect(residency.getLaneRowKeys(LANE_A)).not.toBeNull()
    rmSync(join(lanesRoot, LANE_A, '.credentials.json'))
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.laneState).toBe('absent')
    expect(residency.getLaneRowKeys(LANE_A)).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('runs the startup pass once per lane and rotates in none of them', async () => {
    putLaneFiles('rt-1')
    const outcomes = await driver.syncAllLanesAtStartup([LANE_A, LANE_A])
    expect(outcomes).toHaveLength(2)
    expect(outcomes.every((outcome) => !outcome.rotated)).toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })
})
