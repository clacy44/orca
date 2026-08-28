import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrincipalLaneStore } from './principal-lane-store'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

const credentials = (refreshToken: string, expiresAt: number, accountId = 'acc-1'): string =>
  JSON.stringify({
    claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt, accountId }
  })

// Rev 32 (S9-L3, §10(g)) deletes the watermark and its three push-freshness writers: the lane's
// own CLI is the only writer to its file now, so `PrincipalLaneStore` reads that file live rather
// than judging a write against a cached, persisted row. The push-freshness coverage that used to
// live here goes with the deleted `assertPushIsFresh`.
describe('principal lane store', () => {
  let userData = ''
  let lanesRoot = ''
  let store: PrincipalLaneStore

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'principal-lane-store-'))
    lanesRoot = join(userData, 'claude-lanes')
    store = new PrincipalLaneStore({ lanesRoot, platform: 'linux' })
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('reports a provisioned but empty lane as absent', () => {
    expect(store.getLaneState(LANE_A)).toBe('absent')
    expect(store.getCredentialState(LANE_A)).toBeNull()
  })

  it('reports a lane holding a credential as loaded, read live off the file', () => {
    writeFileSync(join(lanesRoot, LANE_A, '.credentials.json'), credentials('rt-1', 500))
    expect(store.getLaneState(LANE_A)).toBe('loaded')
    const state = store.getCredentialState(LANE_A)
    expect(state?.expiresAt).toBe(500)
    expect(state?.refreshTokenSha256).not.toBeNull()
  })

  it("observes a rotation the lane's own CLI made with no Orca write in between", () => {
    writeFileSync(join(lanesRoot, LANE_A, '.credentials.json'), credentials('rt-1', 100))
    const before = store.getCredentialState(LANE_A)
    writeFileSync(join(lanesRoot, LANE_A, '.credentials.json'), credentials('rt-2', 200))
    const after = store.getCredentialState(LANE_A)
    expect(after?.expiresAt).toBe(200)
    expect(after?.refreshTokenSha256).not.toBe(before?.refreshTokenSha256)
  })

  it('keeps lanes apart: reading one lane never answers for another', () => {
    provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
    writeFileSync(join(lanesRoot, LANE_A, '.credentials.json'), credentials('rt-a', 100))
    expect(store.getLaneState(LANE_B)).toBe('absent')
    expect(store.getCredentialState(LANE_B)).toBeNull()
  })

  it("resolves the lane's identity from the oauth-account.json when present", () => {
    writeFileSync(join(lanesRoot, LANE_A, '.credentials.json'), credentials('rt-1', 100))
    writeFileSync(
      join(lanesRoot, LANE_A, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'uuid-1', emailAddress: 'x@example.com' } })
    )
    const state = store.getCredentialState(LANE_A)
    expect(state?.identity.accountUuid).toBe('uuid-1')
    expect(state?.identity.email).toBe('x@example.com')
  })
})
