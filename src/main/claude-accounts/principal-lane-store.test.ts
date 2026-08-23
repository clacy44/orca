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

const credentials = (refreshToken: string, expiresAt: number, accountId = 'acc-1'): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt, accountId }
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
    // The file write inside is synchronous; only darwin's Keychain arm awaits, and it is pinned
    // in lane-credential-writer.test.ts rather than here.
    void store.writer.writeCredentials(laneDir, credentialsJson)
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

  it('lets an ordinary account switch push a target whose own token is older', () => {
    applyPush(LANE_A, credentials('rt-x', 8_000), null)
    // R2: account Y's desktop-stored token was last refreshed earlier than X's, and the push
    // names the watermark's sha correctly, so nothing about it is stale.
    expect(() =>
      applyPush(LANE_A, credentials('rt-y', 4_000, 'acc-2'), hashRefreshToken('rt-x'))
    ).not.toThrow()
    expect(store.getWatermark(LANE_A)?.identity.accountUuid).toBe('acc-2')
    // And the second switch, to a third account, applies too (§5 live step 3b).
    expect(() =>
      applyPush(LANE_A, credentials('rt-z', 2_000, 'acc-3'), hashRefreshToken('rt-y'))
    ).not.toThrow()
  })

  it('still refuses an older blob of the SAME account, sha chain intact', () => {
    applyPush(LANE_A, credentials('rt-x', 8_000), null)
    // Negative control for the switch case above: same account, so the backstop applies.
    expect(() =>
      applyPush(LANE_A, credentials('rt-replay', 4_000), hashRefreshToken('rt-x'))
    ).toThrow(/older than what this host already holds/)
  })

  it('keeps the backstop when neither side can be identified', () => {
    const anonymous = (refreshToken: string, expiresAt: number): string =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt } })
    applyPush(LANE_A, anonymous('rt-x', 8_000), null)
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: anonymous('rt-y', 4_000),
        basedOnRefreshTokenSha256: hashRefreshToken('rt-x')
      })
    ).toThrow(/older than what this host already holds/)
  })

  it('treats a watermark with no refresh-token sha as an unconditional mismatch', () => {
    const noRefreshToken = JSON.stringify({
      claudeAiOauth: { accessToken: 'at', expiresAt: 2_000, accountId: 'acc-1' }
    })
    applyPush(LANE_A, noRefreshToken, null)
    expect(store.getWatermark(LANE_A)?.refreshTokenSha256).toBeNull()
    // A null sha matches nothing, so a later push must carry the reauthentication flag.
    expect(() => applyPush(LANE_A, credentials('rt-2', 9_000), null)).toThrow(
      /older than what this host already holds/
    )
    expect(() => applyPush(LANE_A, credentials('rt-2', 9_000), null, true)).not.toThrow()
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

  it('keeps an unwritable rotation held across a restart and never syncs backward onto it', () => {
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    // The rotated blob never reached the lane, so the file still holds the SPENT rt-1.
    store.recordUnwritableRotation(LANE_A, credentials('rt-rotated', 9_000))
    expect(store.getLaneState(LANE_A)).toBe('reauth-required')

    // The hold rides the persisted row, so a fresh store over the same rows still sees it.
    const reloaded = new PrincipalLaneStore(persistence, { lanesRoot, platform: 'linux' })
    expect(reloaded.getLaneState(LANE_A)).toBe('reauth-required')
    reloaded.recordSyncedLaneCredentials(LANE_A, credentials('rt-1', 2_000))
    expect(reloaded.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-rotated'))
    expect(() =>
      reloaded.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-1', 2_000),
        basedOnRefreshTokenSha256: hashRefreshToken('rt-1')
      })
    ).toThrow(/older than what this host already holds/)

    // Negative control: once a push lifts the hold, writer 1 moves the watermark as before.
    reloaded.recordPushedLaneCredentials(LANE_A, credentials('rt-2', 9_500))
    expect(reloaded.getLaneState(LANE_A)).toBe('loaded')
    reloaded.recordSyncedLaneCredentials(LANE_A, credentials('rt-3', 9_600))
    expect(reloaded.getWatermark(LANE_A)?.refreshTokenSha256).toBe(hashRefreshToken('rt-3'))
  })

  it('records a hold for a lane that has no watermark yet, matching no basedOn at all', () => {
    applyPush(LANE_A, credentials('rt-1', 2_000), null)
    persistence.rows = []
    store.markReauthRequired(LANE_A)
    expect(store.getLaneState(LANE_A)).toBe('reauth-required')
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-1', 2_000),
        basedOnRefreshTokenSha256: null
      })
    ).toThrow(/older than what this host already holds/)
    // A fresh login still recovers it: the hold row carries no expiry to be older than.
    expect(() =>
      store.assertPushIsFresh({
        laneId: LANE_A,
        credentialsJson: credentials('rt-2', 9_000),
        basedOnRefreshTokenSha256: null,
        reauthenticated: true
      })
    ).not.toThrow()
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
