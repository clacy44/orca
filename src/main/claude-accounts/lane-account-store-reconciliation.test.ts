import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLaneAccountIndex, writeLaneAccountIndex } from './lane-account-index'
import { listLaneAccounts } from './principal-lane-account-store'
import { LANE_SWEEP_PASSES, reconcileLaneAccountStore } from './lane-account-store-reconciliation'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })

function plantAccountDir(laneDir: string, laneAccountId: string, marked = true): string {
  const authDir = join(laneDir, 'claude-accounts', laneAccountId, 'auth')
  mkdirSync(authDir, { recursive: true })
  if (marked) {
    writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${laneAccountId}\n`, { mode: 0o600 })
  }
  writeFileSync(join(authDir, '.credentials.json'), CREDENTIALS, { mode: 0o600 })
  return authDir
}

function indexRow(laneAccountId: string) {
  return {
    laneAccountId,
    email: 'a@x.com',
    label: null,
    active: false,
    capturedAt: '2026-08-27T00:00:00.000Z'
  }
}

describe('reconcileLaneAccountStore', () => {
  let laneDir = ''

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-reconcile-'))
  })

  afterEach(() => {
    rmSync(laneDir, { recursive: true, force: true })
  })

  it('is a no-op when claude-accounts does not exist', () => {
    const result = reconcileLaneAccountStore(laneDir)

    expect(result.arm).toBe('none')
  })

  it('is a no-op with an absent index over an empty (but existing) root', () => {
    mkdirSync(join(laneDir, 'claude-accounts'), { recursive: true })

    const result = reconcileLaneAccountStore(laneDir)

    expect(result.arm).toBe('none')
  })

  it('chmods a pre-existing 0755 root back to 0700 on posix, regardless of which arm runs', () => {
    const root = join(laneDir, 'claude-accounts')
    mkdirSync(root, { recursive: true, mode: 0o755 })

    reconcileLaneAccountStore(laneDir)

    expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  it('does not chmod on win32 — the ACL there comes from the lane dir, not this root', () => {
    const root = join(laneDir, 'claude-accounts')
    mkdirSync(root, { recursive: true, mode: 0o755 })

    reconcileLaneAccountStore(laneDir, { platform: 'win32' })

    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o755)
    }
  })

  // MP: dropping the `lstatSync(...).isSymbolicLink()` guard before the chmod turns this red —
  // the target directory's mode gets rewritten to 0700 through the link.
  it('refuses to chmod through a symlinked claude-accounts root', () => {
    const outside = join(laneDir, '..', `orca-lane-reconcile-outside-${Date.now()}`)
    mkdirSync(outside, { recursive: true, mode: 0o755 })
    try {
      symlinkSync(outside, join(laneDir, 'claude-accounts'))

      reconcileLaneAccountStore(laneDir)

      expect(statSync(outside).mode & 0o777).toBe(0o755)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // Negative control: an unlinked root at the same starting mode still gets corrected, so the
  // guard above is proven to be checking the symlink, not accidentally disabling the chmod outright.
  it('still chmods a non-symlinked 0755 root (negative control for the symlink guard)', () => {
    const root = join(laneDir, 'claude-accounts')
    mkdirSync(root, { recursive: true, mode: 0o755 })

    reconcileLaneAccountStore(laneDir)

    expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  describe('restart reaping (arm A)', () => {
    it('deletes a complete, unindexed credential written into <id>/auth', () => {
      // ID_B is indexed and present so the store is genuinely non-empty and parsed — arm A —
      // rather than the "parses empty over a non-empty store" shape, which is arm B.
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('a')
      expect(result.deletedLaneAccountIds).toEqual([ID_A])
      expect(existsSync(join(laneDir, 'claude-accounts', ID_A))).toBe(false)
      expect(existsSync(join(laneDir, 'claude-accounts', ID_B))).toBe(true)
      expect(listLaneAccounts(laneDir).map((a) => a.laneAccountId)).toEqual([ID_B])
    })

    // MP: writing the marker AFTER capture instead of before the spawn — simulated here as an
    // unmarked directory — makes the purge/resolve unable to prove ownership, but reconciliation's
    // DELETE arm must still remove it (it is unindexed either way; the marker only gates whether
    // it is ever OFFERED, never whether an orphan sweep may remove it).
    it('deletes an unindexed directory even when its marker is missing', () => {
      plantAccountDir(laneDir, ID_A, false)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('a')
      expect(result.deletedLaneAccountIds).toEqual([ID_A])
    })

    it('leaves an indexed, credentialed account alone', () => {
      plantAccountDir(laneDir, ID_A)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A)])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('a')
      expect(result.deletedLaneAccountIds).toEqual([])
      expect(result.droppedDanglingLaneAccountIds).toEqual([])
      expect(existsSync(join(laneDir, 'claude-accounts', ID_A))).toBe(true)
    })

    it('drops a row whose directory is missing', () => {
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A)])
      // A non-account file so the root is non-empty and this stays arm A via the rows-present path.
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A), indexRow(ID_B)])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.droppedDanglingLaneAccountIds).toEqual([ID_A])
      expect(
        readLaneAccountIndex(join(laneDir, 'claude-accounts')).map((r) => r.laneAccountId)
      ).toEqual([ID_B])
    })

    it('drops a row whose directory exists but holds no credential', () => {
      const authDir = join(laneDir, 'claude-accounts', ID_A, 'auth')
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${ID_A}\n`, { mode: 0o600 })
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A)])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.droppedDanglingLaneAccountIds).toEqual([ID_A])
    })

    // MP: skipping the reconciliation at startup turns this red with a complete grant at 0600.
    it('the persisted-state-loss scenario: every INDEXED login in every lane survives a corrupt-registry restart', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A), indexRow(ID_B)])

      // "Wipe Orca's persisted state to defaults" has no analogue for THIS store — the whole point
      // of §storeLayout's design is that the index lives in the lane, never in `persistence.ts` —
      // so simulating the persisted-state loss here means asserting reconciliation reads only the
      // lane's OWN index, never touching anything outside `laneDir`.
      const result = reconcileLaneAccountStore(laneDir)

      expect(result.deletedLaneAccountIds).toEqual([])
      expect(result.droppedDanglingLaneAccountIds).toEqual([])
      expect(
        listLaneAccounts(laneDir)
          .map((a) => a.laneAccountId)
          .sort()
      ).toEqual([ID_A, ID_B].sort())
    })

    it('re-reads under LANE_SWEEP_PASSES and reports a reappearing directory rather than a clean store', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])
      const authRoot = join(laneDir, 'claude-accounts', ID_A)
      const passes: number[] = []

      // Recreate the deleted directory right after pass 1, simulating "a login child from a
      // previous process is still writing" (§storeLayout consequence 3) — the same seam
      // `wipeLaneCredentials`'s own re-read test uses (`onSweptPass`).
      const result = reconcileLaneAccountStore(laneDir, {
        onSweptPass: (pass) => {
          passes.push(pass)
          if (pass === 1) {
            mkdirSync(join(authRoot, 'auth'), { recursive: true })
            writeFileSync(join(authRoot, 'auth', '.orca-managed-claude-auth'), `${ID_A}\n`)
            writeFileSync(join(authRoot, 'auth', '.credentials.json'), CREDENTIALS)
          }
        }
      })

      expect(passes).toEqual([1, 2])
      expect(result.reappeared).toBe(true)
      expect(existsSync(authRoot)).toBe(false)
    })

    it('caps at LANE_SWEEP_PASSES when a directory reappears on every pass', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])
      const authRoot = join(laneDir, 'claude-accounts', ID_A)
      const passes: number[] = []

      const result = reconcileLaneAccountStore(laneDir, {
        onSweptPass: (pass) => {
          passes.push(pass)
          mkdirSync(join(authRoot, 'auth'), { recursive: true })
          writeFileSync(join(authRoot, 'auth', '.orca-managed-claude-auth'), `${ID_A}\n`)
        }
      })

      expect(passes).toEqual([1, 2, 3])
      expect(passes).toHaveLength(LANE_SWEEP_PASSES)
      expect(result.reappeared).toBe(true)
      // Deliberately at rest, not deleted-and-forgotten: the LAST pass's re-creation is left in
      // place for the NEXT run to catch, per this arm's own "never deletes credential bytes
      // outright" boundary — there is nothing here to distinguish from a live writer's own file.
      expect(existsSync(authRoot)).toBe(true)
    })

    // Negative control: nothing reappears, so the sweep runs its one pass and stops.
    it('does not report reappeared when nothing recreates the directory', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])
      const passes: number[] = []

      const result = reconcileLaneAccountStore(laneDir, {
        onSweptPass: (pass) => passes.push(pass)
      })

      expect(passes).toEqual([1])
      expect(result.reappeared).toBe(false)
    })
  })

  describe('arm B quarantine', () => {
    it('quarantines every unindexed dir (renamed, not removed) on an unparseable index', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), '{not json', { mode: 0o600 })

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('b')
      expect(result.quarantinedLaneAccountIds.sort()).toEqual([ID_A, ID_B].sort())
      const entries = readdirSync(join(laneDir, 'claude-accounts'))
      expect(entries.some((name) => name.startsWith(`${ID_A}.quarantined-`))).toBe(true)
      expect(entries.some((name) => name.startsWith(`${ID_B}.quarantined-`))).toBe(true)
      // Not removed: the credential is still readable at rest under the quarantined name.
      const quarantinedA = entries.find((name) => name.startsWith(`${ID_A}.quarantined-`))!
      expect(
        existsSync(join(laneDir, 'claude-accounts', quarantinedA, 'auth', '.credentials.json'))
      ).toBe(true)
    })

    it('quarantines on a missing index over a non-empty store', () => {
      plantAccountDir(laneDir, ID_A)

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('b')
      expect(result.quarantinedLaneAccountIds).toEqual([ID_A])
    })

    // "Add the empty-parse arm: a zero-row index over a store holding directories is arm B."
    it('quarantines when the index parses empty over a store that is not', () => {
      plantAccountDir(laneDir, ID_A)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [])

      const result = reconcileLaneAccountStore(laneDir)

      expect(result.arm).toBe('b')
      expect(result.quarantinedLaneAccountIds).toEqual([ID_A])
    })

    it('writes an empty index after quarantining', () => {
      plantAccountDir(laneDir, ID_A)
      writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), 'garbage')

      reconcileLaneAccountStore(laneDir)

      expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
    })

    // A SECOND lane with a good index reconciles normally in the same pass as a damaged one.
    it('does not let one damaged lane abort or skip a separately reconciled good lane', () => {
      const goodLaneDir = mkdtempSync(join(tmpdir(), 'orca-lane-reconcile-good-'))
      try {
        plantAccountDir(laneDir, ID_A)
        writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), 'garbage')
        plantAccountDir(goodLaneDir, ID_B)
        writeLaneAccountIndex(join(goodLaneDir, 'claude-accounts'), [indexRow(ID_B)])

        const damaged = reconcileLaneAccountStore(laneDir)
        const good = reconcileLaneAccountStore(goodLaneDir)

        expect(damaged.arm).toBe('b')
        expect(good.arm).toBe('a')
        expect(existsSync(join(goodLaneDir, 'claude-accounts', ID_B))).toBe(true)
      } finally {
        rmSync(goodLaneDir, { recursive: true, force: true })
      }
    })

    it('listLaneAccounts on the damaged lane returns empty; the active credential still loads', () => {
      plantAccountDir(laneDir, ID_A)
      writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), 'garbage')
      writeFileSync(join(laneDir, '.credentials.json'), CREDENTIALS, { mode: 0o600 })

      reconcileLaneAccountStore(laneDir)

      expect(listLaneAccounts(laneDir)).toEqual([])
      expect(existsSync(join(laneDir, '.credentials.json'))).toBe(true)
    })

    // MP: falling back to a directory walk when the index will not parse would offer an
    // unvouched-for login to a human. It must not appear even once quarantined.
    it('never offers a quarantined directory through listLaneAccounts', () => {
      plantAccountDir(laneDir, ID_A)
      writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), 'garbage')

      reconcileLaneAccountStore(laneDir)

      expect(listLaneAccounts(laneDir)).toEqual([])
    })
  })

  describe('surviving child', () => {
    // Cross-restart shape of §storeLayout consequence (3): a directory a previous run just
    // deleted is back by the NEXT run. Each run reports the truth about what IT saw — never a
    // false "clean" — rather than remembering the earlier deletion. (The same-call, cross-pass
    // shape of this is `reappeared: true`, covered above under "restart reaping".)
    it('deletes again, and does not report a false clean store, when a directory is re-planted between two runs', () => {
      plantAccountDir(laneDir, ID_A)
      plantAccountDir(laneDir, ID_B)
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_B)])
      const authRoot = join(laneDir, 'claude-accounts', ID_A)

      const first = reconcileLaneAccountStore(laneDir)
      expect(first.deletedLaneAccountIds).toEqual([ID_A])
      expect(existsSync(authRoot)).toBe(false)

      plantAccountDir(laneDir, ID_A)
      const second = reconcileLaneAccountStore(laneDir)
      expect(second.deletedLaneAccountIds).toEqual([ID_A])
      expect(existsSync(authRoot)).toBe(false)
    })
  })
})
