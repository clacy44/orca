/**
 * S9 §2f — the sweep RE-READS before it reports.
 *
 * "A wipe reported over an unread directory is the same failure as one that never ran": the
 * start-side fence is a check rather than a proof, so a `claude` that slipped it can write
 * `.credentials.json` back after the pass that removed it. The wipe is reported only after a
 * clean read-back, and refuses by name when the directory never comes back clean.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readLaneAccountIndex, writeLaneAccountIndex } from './lane-account-index'
import { listLaneAccounts } from './principal-lane-account-store'
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

  /**
   * WIRING PROOF (S9-L1 B2/§storeLayout "PURGE"): `purgeLaneAccountStore` has a real production
   * caller — `wipeLaneCredentials`, itself reachable from `deprovisionLane`'s RPC/IPC handlers —
   * and not just its own unit tests. No call into the account-store module from this test.
   */
  it('purges the claude-accounts store once the active credential is confirmed swept', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    const strayId = '77777777-7777-4777-8777-777777777777'
    mkdirSync(join(accountsRoot, strayId, 'auth'), { recursive: true })
    writeFileSync(join(accountsRoot, strayId, 'auth', '.orca-managed-claude-auth'), `${strayId}\n`)
    writeFileSync(join(accountsRoot, strayId, 'auth', '.credentials.json'), CREDENTIALS)
    writeLaneAccountIndex(accountsRoot, [
      {
        laneAccountId: strayId,
        email: 'a@x.com',
        label: null,
        active: false,
        capturedAt: '2026-08-27T00:00:00.000Z'
      }
    ])

    const removed = await wipeLaneCredentials(laneDir, { platform: 'linux' })

    expect(existsSync(join(accountsRoot, strayId))).toBe(false)
    expect(existsSync(join(accountsRoot, 'index.json'))).toBe(false)
    expect(removed).toContain(strayId)
    expect(listLaneAccounts(laneDir)).toEqual([])
    expect(readLaneAccountIndex(accountsRoot)).toEqual([])
  })

  // MP: purging on the THROW path (a credential that keeps reappearing) would delete every OTHER
  // login this lane holds even though the wipe itself was never confirmed done.
  it('does not purge the account store when the sweep never reads back clean', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    const keptId = '66666666-6666-4666-8666-666666666666'
    mkdirSync(join(accountsRoot, keptId, 'auth'), { recursive: true })
    writeFileSync(join(accountsRoot, keptId, 'auth', '.orca-managed-claude-auth'), `${keptId}\n`)
    writeFileSync(join(accountsRoot, keptId, 'auth', '.credentials.json'), CREDENTIALS)
    writeLaneAccountIndex(accountsRoot, [
      {
        laneAccountId: keptId,
        email: 'a@x.com',
        label: null,
        active: false,
        capturedAt: '2026-08-27T00:00:00.000Z'
      }
    ])

    await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onSweptPass: () => writeFileSync(credentialsPath(), CREDENTIALS, { mode: 0o600 })
    }).catch(() => undefined)

    expect(existsSync(join(accountsRoot, keptId))).toBe(true)
  })

  // The failure this closes: a detached login child from a PREVIOUS process re-creating a
  // `<uuid>/auth` directory in `claude-accounts/` right after this sweep's own purge removed it —
  // the re-read must catch it on the very next pass, same discipline as the credential file.
  it('sweeps the account store again when a login capture directory reappears after the first purge', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    const reappearingId = '55555555-5555-4555-8555-555555555555'
    const storePasses: number[] = []

    const removed = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onStorePurged: (pass) => {
        storePasses.push(pass)
        if (pass === 1) {
          mkdirSync(join(accountsRoot, reappearingId, 'auth'), { recursive: true })
          writeFileSync(
            join(accountsRoot, reappearingId, 'auth', '.orca-managed-claude-auth'),
            `${reappearingId}\n`
          )
          writeFileSync(join(accountsRoot, reappearingId, 'auth', '.credentials.json'), CREDENTIALS)
        }
      }
    })

    expect(storePasses).toEqual([1, 2])
    expect(existsSync(join(accountsRoot, reappearingId))).toBe(false)
    expect(removed).toContain(reappearingId)
  })

  // MP anchor: today's single-shot purge (no re-read) would report this wipe `completed`, over a
  // directory that in fact never came back clean.
  it('refuses logout_incomplete, never reporting success, when the account store never reads back clean', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    const stuckId = '44444444-4444-4444-8444-444444444444'

    const error = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onStorePurged: () => {
        mkdirSync(join(accountsRoot, stuckId, 'auth'), { recursive: true })
        writeFileSync(
          join(accountsRoot, stuckId, 'auth', '.orca-managed-claude-auth'),
          `${stuckId}\n`
        )
        writeFileSync(join(accountsRoot, stuckId, 'auth', '.credentials.json'), CREDENTIALS)
      }
    }).catch((thrown: unknown) => thrown)

    expect(isClaudeLaneRefusal(error)).toBe(true)
    expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.logout_incomplete')
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

  // P-F (review finding): an entry `purgeLaneAccountStore` is contracted to LEAVE must not make
  // the raw-readdir re-read gate refuse forever — the everyday macOS case, one Finder visit.
  it('logs out cleanly when an unrelated file (not credentials, not this store’s shape) sits under claude-accounts', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    mkdirSync(accountsRoot, { recursive: true })
    writeFileSync(join(accountsRoot, '.DS_Store'), 'not a credential')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const removed = await wipeLaneCredentials(laneDir, { platform: 'linux' })

    expect(removed).toContain(LANE_CREDENTIALS_FILENAME)
    // Left in place, exactly as `purgeLaneAccountStore`'s own contract promises — not removed,
    // and not what blocks the logout from reporting done.
    expect(existsSync(join(accountsRoot, '.DS_Store'))).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('.DS_Store'))
    warnSpy.mockRestore()
  })

  // P-G (review finding): a symlink named as a v4 UUID — the shape `purgeLaneAccountStore`'s own
  // comment says it will not touch — must not pin logout/revoke either.
  it('logs out cleanly when a symlink under claude-accounts is left in place by the purge', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    const decoyTarget = mkdtempSync(join(tmpdir(), 'orca-lane-sweep-decoy-'))
    const decoyId = '99999999-9999-4999-8999-999999999999'
    mkdirSync(accountsRoot, { recursive: true })
    symlinkSync(decoyTarget, join(accountsRoot, decoyId))

    try {
      const removed = await wipeLaneCredentials(laneDir, { platform: 'linux' })

      expect(removed).toContain(LANE_CREDENTIALS_FILENAME)
      expect(existsSync(join(accountsRoot, decoyId))).toBe(true)
    } finally {
      rmSync(decoyTarget, { recursive: true, force: true })
    }
  })

  // Negative control alongside P-F/P-G: a genuinely purgeable directory that keeps regrowing
  // must still refuse — the fix narrows the gate, it must not widen it into never refusing.
  it('still refuses logout_incomplete when a real login-capture directory keeps reappearing, foreign junk or not', async () => {
    const accountsRoot = join(laneDir, 'claude-accounts')
    mkdirSync(accountsRoot, { recursive: true })
    writeFileSync(join(accountsRoot, '.DS_Store'), 'not a credential')
    const stuckId = '33333333-3333-4333-8333-333333333333'

    const error = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onStorePurged: () => {
        mkdirSync(join(accountsRoot, stuckId, 'auth'), { recursive: true })
        writeFileSync(
          join(accountsRoot, stuckId, 'auth', '.orca-managed-claude-auth'),
          `${stuckId}\n`
        )
        writeFileSync(join(accountsRoot, stuckId, 'auth', '.credentials.json'), CREDENTIALS)
      }
    }).catch((thrown: unknown) => thrown)

    expect(isClaudeLaneRefusal(error)).toBe(true)
    expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.logout_incomplete')
  })

  it('refuses by name rather than reporting a wipe the directory contradicts', async () => {
    const error = await wipeLaneCredentials(laneDir, {
      platform: 'linux',
      onSweptPass: () => writeFileSync(credentialsPath(), CREDENTIALS, { mode: 0o600 })
    }).catch((thrown: unknown) => thrown)

    expect(isClaudeLaneRefusal(error)).toBe(true)
    expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.logout_incomplete')
    // The identity is NOT dropped: nothing may report this lane released.
    expect(JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8'))).toHaveProperty(
      'oauthAccount'
    )
  })
})
