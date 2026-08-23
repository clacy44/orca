/**
 * S9 §2f — the sweep RE-READS before it reports.
 *
 * "A wipe reported over an unread directory is the same failure as one that never ran": the
 * start-side fence is a check rather than a proof, so a `claude` that slipped it can write
 * `.credentials.json` back after the pass that removed it. The wipe is reported only after a
 * clean read-back, and refuses by name when the directory never comes back clean.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  LANE_CREDENTIALS_FILENAME,
  listLaneCredentialArtifacts,
  wipeLaneCredentials
} from './principal-lane-credential-sweep'

const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })

describe('the lane wipe re-read', () => {
  let laneDir = ''

  const credentialsPath = (): string => join(laneDir, LANE_CREDENTIALS_FILENAME)

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-sweep-'))
    writeFileSync(credentialsPath(), CREDENTIALS, { mode: 0o600 })
    writeFileSync(join(laneDir, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'a' } }))
  })

  afterEach(() => {
    rmSync(laneDir, { recursive: true, force: true })
  })

  it('sweeps again when the credential reappears after the first pass', async () => {
    const passes: number[] = []

    const removed = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onSweptPass: (pass) => {
        passes.push(pass)
        if (pass === 1) {
          // The mid-rotation `claude` §2f names, writing the lane's own file back.
          writeFileSync(credentialsPath(), CREDENTIALS, { mode: 0o600 })
        }
      }
    })

    expect(passes).toEqual([1, 2])
    expect(existsSync(credentialsPath())).toBe(false)
    expect(removed).toContain(LANE_CREDENTIALS_FILENAME)
    // The identity is dropped only on the clean read-back, so it goes with the second pass.
    expect(JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8'))).toEqual({})
  })

  it('sweeps a staged .tmp copy the writer left behind before it reports', async () => {
    writeFileSync(join(laneDir, '.credentials.json.4242.abc.tmp'), CREDENTIALS, { mode: 0o600 })

    const removed = await wipeLaneCredentials(laneDir, { platform: 'linux' })

    expect(listLaneCredentialArtifacts(laneDir)).toEqual([])
    expect(removed).toContain('.credentials.json.4242.abc.tmp')
  })

  // Negative control: a lane that comes back clean is swept ONCE, not re-swept on a timer.
  it('reads back once when nothing reappears', async () => {
    const passes: number[] = []

    await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onSweptPass: (pass) => passes.push(pass)
    })

    expect(passes).toEqual([1])
  })

  it('refuses by name rather than reporting a wipe the directory contradicts', async () => {
    const error = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onSweptPass: () => writeFileSync(credentialsPath(), CREDENTIALS, { mode: 0o600 })
    }).catch((thrown: unknown) => thrown)

    expect(isClaudeLaneRefusal(error)).toBe(true)
    expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.clear_incomplete')
    // The identity is NOT dropped: nothing may report this lane released.
    expect(JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8'))).toHaveProperty(
      'oauthAccount'
    )
  })
})
