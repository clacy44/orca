import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaneAuthState } from './lane-auth-state'
import { LaneSyncDriver } from './lane-sync-driver'
import { PrincipalLaneStore } from './principal-lane-store'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const ACCOUNT_X = 'account-x'

const credentials = (refreshToken: string, expiresAt = 0): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt } })

// Rev 32 (S9-L3, §10(g)) deletes Orca's managed rotation of a lane's chain and the persisted
// watermark it judged a push against: `LaneSyncDriver` shrinks to a live identity resolver, taken
// under the lane's write queue. The rotation/foreign-change/receipt coverage that used to live here
// goes with the deleted mechanism.
describe('lane sync driver', () => {
  let userData = ''
  let lanesRoot = ''
  let store: PrincipalLaneStore
  let authState: LaneAuthState
  let driver: LaneSyncDriver

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
    userData = mkdtempSync(join(tmpdir(), 'lane-sync-driver-'))
    lanesRoot = join(userData, 'claude-lanes')
    store = new PrincipalLaneStore({ lanesRoot, platform: 'linux' })
    authState = new LaneAuthState()
    driver = new LaneSyncDriver({ store, authState })
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('reads laneState absent when the lane holds no credential', async () => {
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome).toEqual({
      laneId: LANE_A,
      trigger: 'launch',
      laneState: 'absent',
      credentialState: null
    })
  })

  it("reads the lane's own identity and refresh sha live off its file once loaded", async () => {
    putLaneFiles('rt-1', 999)
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.laneState).toBe('loaded')
    expect(outcome.credentialState?.identity.accountUuid).toBe(ACCOUNT_X)
    expect(outcome.credentialState?.expiresAt).toBe(999)
  })

  it("a second sync observes a rotation the lane's own CLI made, with no Orca write of its own", async () => {
    putLaneFiles('rt-1', 100)
    await driver.syncLane(LANE_A, 'launch')
    putLaneFiles('rt-2', 200)
    const outcome = await driver.syncLane(LANE_A, 'launch')
    expect(outcome.credentialState?.refreshTokenSha256).not.toBeNull()
    expect(outcome.credentialState?.expiresAt).toBe(200)
  })

  it('serializes through the lane write queue, never straddling an in-flight write', async () => {
    putLaneFiles('rt-1', 100)
    const order: string[] = []
    const held = authState.serializeLaneWrite(LANE_A, async () => {
      order.push('write-start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('write-end')
    })
    const readAfter = driver.syncLane(LANE_A, 'launch').then((outcome) => {
      order.push('read')
      return outcome
    })
    await Promise.all([held, readAfter])
    expect(order).toEqual(['write-start', 'write-end', 'read'])
  })
})
