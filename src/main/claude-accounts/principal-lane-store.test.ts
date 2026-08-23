import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { hashRefreshToken } from './claude-credential-identity'
import { PrincipalLaneStore, type LaneRotationReceipt } from './principal-lane-store'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

const credentials = (refreshToken: string, expiresAt: number): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt, accountId: 'acc-1' }
  })

class FakeWatermarkPersistence {
  rows: ClaudeLaneCredentialWatermark[] = []
  writes = 0

  getClaudeLaneCredentialWatermarks(): ClaudeLaneCredentialWatermark[] {
    return this.rows.map((row) => ({ ...row, identity: { ...row.identity } }))
  }

  setClaudeLaneCredentialWatermarks(rows: readonly ClaudeLaneCredentialWatermark[]): void {
    this.writes += 1
    this.rows = rows.map((row) => ({ ...row, identity: { ...row.identity } }))
  }
}

describe('principal lane store', () => {
  let userData = ''
  let lanesRoot = ''
  let persistence: FakeWatermarkPersistence
  let store: PrincipalLaneStore

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-store-'))
    lanesRoot = join(userData, 'claude-lanes')
    persistence = new FakeWatermarkPersistence()
    store = new PrincipalLaneStore(persistence, { lanesRoot, platform: 'linux' })
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  /** §2c ordering: sync (trigger 3) → freshness → write → watermark. */
  const applyPush = (
    laneId: string,
    credentialsJson: string,
    basedOnRefreshTokenSha256: string | null,
    reauthenticated = false
  ): void => {
    const onDisk = store.readLaneCredentials(laneId)
    if (onDisk) {
      store.recordSyncedLaneCredentials(laneId, onDisk, store.readLaneOauthAccount(laneId))
    }
    store.assertPushIsFresh({ laneId, credentialsJson, basedOnRefreshTokenSha256, reauthenticated })
    const laneDir = store.resolveLaneDir(laneId)
    if (!laneDir) {
      throw new Error('lane not resolvable')
    }
    store.writer.writeCredentials(laneDir, credentialsJson)
    store.recordPushedLaneCredentials(laneId, credentialsJson)
  }

  it('reports a provisioned but empty lane as absent and a pushed one as loaded', () => {
    expect(store.getLaneState(LANE_A)).toBe('absent')
    expect(store.getLaneState(LANE_B)).toBe('absent')
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    expect(store.getLaneState(LANE_A)).toBe('loaded')
  })

  it('lets two consecutive pushes from the same desktop both succeed', () => {
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    // The second push is based on what the first one pushed — the push-arm watermark write.
    expect(() =>
      applyPush(LANE_A, credentials('rt-2', 3_000), hashRefreshToken('rt-1'))
    ).not.toThrow()
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-2'))
  })

  it('refuses a push based on a sha the lane has moved past', () => {
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    expect(() => applyPush(LANE_A, credentials('rt-2', 3_000), hashRefreshToken('stale'))).toThrow(
      /older than what this host already holds/
    )
  })

  it('refuses a strictly older blob even when the push claims reauthentication', () => {
    applyPush(LANE_A, credentials('rt-1', 5_000), null)
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-9', 4_000),
        basedOnRefreshTokenSha256: null,
        reauthenticated: true
      })
    ).toThrow(/older than what this host already holds/)
  })

  it('lets a reauthenticated push break the sha chain when it is not older', () => {
    applyPush(LANE_A, credentials('rt-1', 5_000), null)
    expect(() =>
      applyPush(LANE_A, credentials('rt-fresh', 9_000), hashRefreshToken('unrelated'), true)
    ).not.toThrow()
  })

  it('accepts the first push of a lane, which has no watermark to be based on', () => {
    expect(() => applyPush(LANE_A, credentials('rt-1', 2_000), null)).not.toThrow()
    expect(persistence.rows).toHaveLength(1)
  })

  it('moves the watermark from all three writers and keeps one row per lane', () => {
    store.recordSyncedLaneCredentials(LANE_A, credentials('rt-sync', 1_000))
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-sync'))
    store.recordPushedLaneCredentials(LANE_A, credentials('rt-push', 2_000))
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-push'))
    store.recordRotationReceipt({
      laneId: LANE_A,
      identity: { accountUuid: 'acc-1', email: null, organizationUuid: null },
      refreshTokenSha256: hashRefreshToken('rt-rotated'),
      expiresAt: 3_000,
      cause: 'host'
    })
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-rotated'))
    expect(persistence.rows).toHaveLength(1)
  })

  it('publishes every rotation receipt to its subscribers until they unsubscribe', () => {
    const seen: LaneRotationReceipt[] = []
    const dispose = store.onRotationReceipt((receipt) => seen.push(receipt))
    const receipt: LaneRotationReceipt = {
      laneId: LANE_A,
      identity: { accountUuid: 'acc-1', email: null, organizationUuid: null },
      refreshTokenSha256: hashRefreshToken('rt-cli'),
      expiresAt: 4_000,
      cause: 'cli-observed'
    }
    store.recordRotationReceipt(receipt)
    dispose()
    store.recordRotationReceipt({ ...receipt, cause: 'host' })
    expect(seen).toEqual([receipt])
  })

  it('holds a foreign rotation at reauth-required until a push lands', () => {
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    store.recordRotationReceipt({
      laneId: LANE_A,
      identity: { accountUuid: 'acc-1', email: null, organizationUuid: null },
      refreshTokenSha256: hashRefreshToken('rt-foreign'),
      expiresAt: 2_500,
      cause: 'foreign-rotation'
    })
    expect(store.getLaneState(LANE_A)).toBe('reauth-required')
    // Recovery is a reauthenticated push: a foreign rotation broke the sha chain by definition.
    applyPush(LANE_A, credentials('rt-3', 6_000), null, true)
    // Negative control: a cli-observed receipt does NOT put the lane into reauth-required.
    expect(store.getLaneState(LANE_A)).toBe('loaded')
    store.recordRotationReceipt({
      laneId: LANE_A,
      identity: { accountUuid: 'acc-1', email: null, organizationUuid: null },
      refreshTokenSha256: hashRefreshToken('rt-4'),
      expiresAt: 7_000,
      cause: 'cli-observed'
    })
    expect(store.getLaneState(LANE_A)).toBe('loaded')
  })

  it('stores a sha and an identity, never the refresh token itself', () => {
    applyPush(LANE_A, credentials('super-secret-refresh', 2_000), null)
    expect(JSON.stringify(persistence.rows)).not.toContain('super-secret-refresh')
    expect(store.getWatermark(LANE_A)?.identity.accountUuid).toBe('acc-1')
  })

  it('keeps lanes apart: a watermark on one lane never answers for the other', () => {
    provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
    applyPush(LANE_A, credentials('rt-a', 2_000), null)
    expect(store.getWatermark(LANE_B)).toBeNull()
    expect(() => applyPush(LANE_B, credentials('rt-b', 1_000), null)).not.toThrow()
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-a'))
    expect(store.getWatermark(LANE_B)?.refreshTokenSha256).toBe(hashRefreshToken('rt-b'))
  })
})
