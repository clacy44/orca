import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  it('refuses to treat a malformed refresh response as a rotation', async () => {
    const authState = makeState(async () =>
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })
    )
    await expect(
      authState.rotateLaneCredentials({
        laneId: LANE_A,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: null,
        credentialsJson: credentials('rt-x')
      })
    ).resolves.toEqual({ status: 'refresh-failed' })
    expect(store.readLaneCredentials(LANE_A)).toBeNull()
  })

  it('does not rotate a credential that is not expiring', async () => {
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
        refreshTokenSha256: null,
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
    const active: string[] = []
    const authState = makeState(async (credentialsJson) => {
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
        refreshTokenSha256: null,
        credentialsJson: credentials('rt-1')
      }),
      authState.rotateLaneCredentials({
        laneId: LANE_B,
        accountUuid: ACCOUNT_X,
        refreshTokenSha256: null,
        credentialsJson: credentials('rt-2')
      })
    ])
    expect(active).toEqual([])
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
