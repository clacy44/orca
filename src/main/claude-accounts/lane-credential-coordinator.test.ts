import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import { LaneCredentialCoordinator } from './lane-credential-coordinator'
import {
  SHARED_CLAUDE_LANE_KEY,
  listLanesWithLiveClaudePtys,
  markClaudePtyExited,
  markClaudePtySpawned
} from './live-pty-gate'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

const credentials = (refreshToken: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken, expiresAt: 0 } })

describe('the lane sync trigger 2 arm', () => {
  let userData = ''
  let lanesRoot = ''
  const rows: ClaudeLaneCredentialWatermark[] = []
  const spawned: string[] = []

  const coordinator = (): LaneCredentialCoordinator =>
    new LaneCredentialCoordinator({
      persistence: {
        getClaudeLaneCredentialWatermarks: () => rows.slice(),
        setClaudeLaneCredentialWatermarks: (next) => {
          rows.length = 0
          rows.push(...next)
        }
      },
      sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
      laneOptions: { lanesRoot, platform: 'linux' }
    })

  const spawn = (ptyId: string, laneId: string | null): void => {
    markClaudePtySpawned(ptyId, laneId)
    spawned.push(ptyId)
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-tick-'))
    lanesRoot = join(userData, 'claude-lanes')
    rows.length = 0
    for (const laneId of [LANE_A, LANE_B]) {
      provisionPrincipalLane(laneId, { lanesRoot, platform: 'linux' })
      writeFileSync(join(lanesRoot, laneId, '.credentials.json'), credentials(`rt-${laneId}`))
    }
  })

  afterEach(() => {
    for (const ptyId of spawned.splice(0)) {
      markClaudePtyExited(ptyId)
    }
    rmSync(userData, { recursive: true, force: true })
  })

  it('lists the personal lanes a live claude runs in, and never the shared one', () => {
    spawn('pty-a', LANE_A)
    spawn('pty-a2', LANE_A)
    spawn('pty-host', null)

    // Deduplicated, and the shared lane has no lane file to sync.
    expect(listLanesWithLiveClaudePtys()).toEqual([LANE_A])
    expect(listLanesWithLiveClaudePtys()).not.toContain(SHARED_CLAUDE_LANE_KEY)
  })

  it('syncs each lane holding a live claude on the tick, and no other lane', async () => {
    spawn('pty-a', LANE_A)
    const lanes = coordinator()

    const outcomes = await lanes.syncLanesWithLivePtys()

    expect(outcomes.map((outcome) => [outcome.laneId, outcome.trigger])).toEqual([
      [LANE_A, 'rate-limit-tick']
    ])
    // The watermark is the observable half: lane B's was never read, so it has no row.
    expect(rows.map((row) => row.laneId)).toEqual([LANE_A])
  })

  it('syncs nothing when no lane holds a live claude', async () => {
    spawn('pty-host', null)
    const lanes = coordinator()

    // Negative control: a shared-lane claude is not a lane tick, and a lane with no live pty is
    // left alone until its own launch syncs it.
    expect(await lanes.syncLanesWithLivePtys()).toEqual([])
    expect(rows).toEqual([])
  })
})

/**
 * The usage-attribution post-step runs AFTER the sync has already produced an outcome, and its
 * label is a filesystem WRITE — so it must not be able to turn a successful sync into a failure.
 */
describe('the usage attribution post-step', () => {
  let userData = ''
  let lanesRoot = ''
  const rows: ClaudeLaneCredentialWatermark[] = []

  const coordinator = (): LaneCredentialCoordinator =>
    new LaneCredentialCoordinator({
      persistence: {
        getClaudeLaneCredentialWatermarks: () => rows.slice(),
        setClaudeLaneCredentialWatermarks: (next) => {
          rows.length = 0
          rows.push(...next)
        }
      },
      sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
      laneOptions: { lanesRoot, platform: 'linux' }
    })

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-attribution-'))
    lanesRoot = join(userData, 'claude-lanes')
    rows.length = 0
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
    // Far-future expiry: an expiring blob makes the sync try to ROTATE, which is not what these
    // cases are about.
    writeFileSync(
      join(lanesRoot, LANE_A, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at',
          refreshToken: 'rt-a',
          expiresAt: Date.now() + 3_600_000
        }
      })
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('publishes one attribution row per loaded lane', async () => {
    const lanes = coordinator()

    await lanes.syncLane(LANE_A, 'launch')

    expect(lanes.laneUsageAttributions()).toEqual([
      {
        laneId: LANE_A,
        configDir: join(lanesRoot, LANE_A),
        provenance: expect.stringMatching(/^lane:[0-9a-f]{32}$/) as unknown as string
      }
    ])
  })

  it('still resolves the sync when the provenance label cannot be established', async () => {
    // A label path that is a DIRECTORY: reading and minting both throw, exactly as a lane dir
    // swept between the sync and this post-step would.
    const labelPath = join(lanesRoot, LANE_A, '.orca-lane-provenance')
    rmSync(labelPath, { force: true })
    mkdirSync(labelPath)
    const lanes = coordinator()

    const outcome = await lanes.syncLane(LANE_A, 'launch')

    expect(outcome.laneState).toBe('loaded')
    // Fail closed: no row, so the lane attracts no statusline posts until it can be labelled.
    expect(lanes.laneUsageAttributions()).toEqual([])
  })
})
