import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readLaneAccountIndex, writeLaneAccountIndex } from './lane-account-index'
import {
  MAX_LANE_LOGINS,
  assertLaneAccountStoreHasRoom,
  listLaneAccounts,
  purgeLaneAccountStore,
  removeLaneAccount,
  resolveContainedLaneAccountEntry,
  selectLaneAccount
} from './principal-lane-account-store'
import { isClaudeAuthSwitchInProgress } from './live-pty-gate'
import { LaneAuthState } from './lane-auth-state'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const CREDENTIALS = (email: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: `at-${email}`, refreshToken: `rt-${email}` } })
const OAUTH_ACCOUNT = (email: string): string => JSON.stringify({ id: email, emailAddress: email })

function plantAccount(
  laneDir: string,
  laneAccountId: string,
  email: string,
  options: { marker?: boolean; credentials?: boolean; oauthAccount?: boolean } = {}
): void {
  const authDir = join(laneDir, 'claude-accounts', laneAccountId, 'auth')
  mkdirSync(authDir, { recursive: true })
  if (options.marker !== false) {
    writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${laneAccountId}\n`, { mode: 0o600 })
  }
  if (options.credentials !== false) {
    writeFileSync(join(authDir, '.credentials.json'), CREDENTIALS(email), { mode: 0o600 })
  }
  if (options.oauthAccount !== false) {
    writeFileSync(join(authDir, 'oauth-account.json'), OAUTH_ACCOUNT(email), { mode: 0o600 })
  }
}

function indexRow(laneAccountId: string, email: string, active = false) {
  return { laneAccountId, email, label: null, active, capturedAt: '2026-08-27T00:00:00.000Z' }
}

describe('principal-lane-account-store', () => {
  let laneDir = ''

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-account-store-'))
  })

  afterEach(() => {
    rmSync(laneDir, { recursive: true, force: true })
  })

  describe('managed-auth-path rules, asserted item by item against the lane root', () => {
    it('resolves a marked, credentialed account', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com')])

      const accounts = listLaneAccounts(laneDir)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].authDir).toBe(join(laneDir, 'claude-accounts', ID_A, 'auth'))
    })

    // MP anchor: symlink refusal must be ORDERED FIRST. A symlinked auth dir is refused even
    // though it points at a directory that itself carries a valid marker and credential.
    it('refuses a symlinked auth dir pointing out of the lane account root', () => {
      const outside = join(tmpdir(), `orca-lane-escape-${Date.now()}`)
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, '.orca-managed-claude-auth'), `${ID_A}\n`)
      writeFileSync(join(outside, '.credentials.json'), CREDENTIALS('a@x.com'))
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(join(accountsRoot, ID_A), { recursive: true })
      symlinkSync(outside, join(accountsRoot, ID_A, 'auth'))
      writeLaneAccountIndex(accountsRoot, [indexRow(ID_A, 'a@x.com')])

      try {
        expect(listLaneAccounts(laneDir)).toEqual([])
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('refuses containment: an id whose relative path escapes the root is never offered', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(accountsRoot, { recursive: true })
      // A row naming an id that is not itself a real subdirectory can never resolve — there is
      // nothing for the two-segment match to find under the root.
      writeLaneAccountIndex(accountsRoot, [indexRow(ID_A, 'a@x.com')])

      expect(listLaneAccounts(laneDir)).toEqual([])
    })

    it('requires the exact two-segment <id>/auth match', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      // One segment too many: auth/extra.
      const deep = join(accountsRoot, ID_A, 'auth', 'extra')
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, '.orca-managed-claude-auth'), `${ID_A}\n`)
      writeLaneAccountIndex(accountsRoot, [indexRow(ID_A, 'a@x.com')])

      expect(listLaneAccounts(laneDir)).toEqual([])
    })

    it('requires the marker contents to equal the id', () => {
      const authDir = join(laneDir, 'claude-accounts', ID_A, 'auth')
      mkdirSync(authDir, { recursive: true })
      writeFileSync(join(authDir, '.orca-managed-claude-auth'), `${ID_B}\n`)
      writeFileSync(join(authDir, '.credentials.json'), CREDENTIALS('a@x.com'))
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com')])

      expect(listLaneAccounts(laneDir)).toEqual([])
    })

    it('writes 0600 atomically on select', async () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com', false)])

      await selectLaneAccount(laneDir, 'lane-1', ID_A)

      if (process.platform !== 'win32') {
        const { statSync } = await import('node:fs')
        const mode = statSync(join(laneDir, '.credentials.json')).mode & 0o777
        expect(mode).toBe(0o600)
      }
    })
  })

  // The primary acceptance test of the model: two lanes, two accounts.
  it('two lanes hold two independent accounts — deleting one leaves the other untouched', async () => {
    const laneB = mkdtempSync(join(tmpdir(), 'orca-lane-account-store-b-'))
    try {
      plantAccount(laneDir, ID_A, 'ana@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'ana@x.com', false)])
      await selectLaneAccount(laneDir, 'lane-a', ID_A)

      plantAccount(laneB, ID_B, 'bo@x.com')
      writeLaneAccountIndex(join(laneB, 'claude-accounts'), [indexRow(ID_B, 'bo@x.com', false)])
      await selectLaneAccount(laneB, 'lane-b', ID_B)

      expect(JSON.parse(readFileSync(join(laneDir, '.credentials.json'), 'utf-8'))).toEqual(
        JSON.parse(CREDENTIALS('ana@x.com'))
      )
      expect(JSON.parse(readFileSync(join(laneB, '.credentials.json'), 'utf-8'))).toEqual(
        JSON.parse(CREDENTIALS('bo@x.com'))
      )

      rmSync(join(laneDir, '.credentials.json'), { force: true })

      expect(existsSync(join(laneDir, '.credentials.json'))).toBe(false)
      expect(existsSync(join(laneB, '.credentials.json'))).toBe(true)
    } finally {
      rmSync(laneB, { recursive: true, force: true })
    }
  })

  describe('purge', () => {
    it('removes accounts, quarantined dirs and the index; leaves settings/transcripts/content', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      plantAccount(laneDir, ID_B, 'b@x.com')
      const accountsRoot = join(laneDir, 'claude-accounts')
      writeLaneAccountIndex(accountsRoot, [indexRow(ID_A, 'a@x.com'), indexRow(ID_B, 'b@x.com')])
      mkdirSync(join(accountsRoot, `${ID_C}.quarantined-1`), { recursive: true })
      writeFileSync(join(laneDir, 'settings.json'), '{}')
      mkdirSync(join(laneDir, 'transcripts'), { recursive: true })
      writeFileSync(join(laneDir, 'transcripts', 't1.jsonl'), '{}')

      const removed = purgeLaneAccountStore(laneDir)

      expect(existsSync(join(accountsRoot, ID_A))).toBe(false)
      expect(existsSync(join(accountsRoot, ID_B))).toBe(false)
      expect(existsSync(join(accountsRoot, `${ID_C}.quarantined-1`))).toBe(false)
      expect(existsSync(join(accountsRoot, 'index.json'))).toBe(false)
      expect(removed).toEqual(
        expect.arrayContaining([ID_A, ID_B, `${ID_C}.quarantined-1`, 'index.json'])
      )
      expect(existsSync(join(laneDir, 'settings.json'))).toBe(true)
      expect(readFileSync(join(laneDir, 'transcripts', 't1.jsonl'), 'utf-8')).toBe('{}')
    })

    // MP: keeping the index turns a post-purge listing red with rows naming deleted grants.
    it('leaves listLaneAccounts empty after purge (the index itself is gone)', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com')])

      purgeLaneAccountStore(laneDir)

      expect(listLaneAccounts(laneDir)).toEqual([])
    })

    it('removes a .tmp staging sibling of the index', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(accountsRoot, { recursive: true })
      writeFileSync(join(accountsRoot, 'index.json.4242.abc.tmp'), '[]')

      const removed = purgeLaneAccountStore(laneDir)

      expect(removed).toContain('index.json.4242.abc.tmp')
      expect(existsSync(join(accountsRoot, 'index.json.4242.abc.tmp'))).toBe(false)
    })

    // MP: purging the lane root (rather than scoping to claude-accounts) would delete these too.
    it('is a no-op on a lane with no claude-accounts directory at all', () => {
      writeFileSync(join(laneDir, 'settings.json'), '{}')

      expect(purgeLaneAccountStore(laneDir)).toEqual([])
      expect(existsSync(join(laneDir, 'settings.json'))).toBe(true)
    })

    // MP: a symlinked entry under claude-accounts must be refused, not followed and deleted.
    it('refuses a symlinked entry under claude-accounts rather than deleting through it', () => {
      const outside = join(tmpdir(), `orca-purge-escape-${Date.now()}`)
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'sentinel'), 'still here')
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(accountsRoot, { recursive: true })
      symlinkSync(outside, join(accountsRoot, ID_A))

      try {
        const removed = purgeLaneAccountStore(laneDir)
        expect(removed).not.toContain(ID_A)
        expect(existsSync(join(outside, 'sentinel'))).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  })

  describe('in-lane switch (selectLaneAccount)', () => {
    it('rewrites .credentials.json and merges oauthAccount, flipping the active row', async () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      plantAccount(laneDir, ID_B, 'b@x.com')
      const accountsRoot = join(laneDir, 'claude-accounts')
      writeLaneAccountIndex(accountsRoot, [
        indexRow(ID_A, 'a@x.com', true),
        indexRow(ID_B, 'b@x.com', false)
      ])
      writeFileSync(join(laneDir, '.credentials.json'), CREDENTIALS('a@x.com'))
      writeFileSync(
        join(laneDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { id: 'a@x.com' } })
      )

      await selectLaneAccount(laneDir, 'lane-1', ID_B)

      expect(JSON.parse(readFileSync(join(laneDir, '.credentials.json'), 'utf-8'))).toEqual(
        JSON.parse(CREDENTIALS('b@x.com'))
      )
      expect(JSON.parse(readFileSync(join(laneDir, '.claude.json'), 'utf-8')).oauthAccount).toEqual(
        JSON.parse(OAUTH_ACCOUNT('b@x.com'))
      )
      const rows = readLaneAccountIndex(accountsRoot)
      expect(rows.find((r) => r.laneAccountId === ID_A)?.active).toBe(false)
      expect(rows.find((r) => r.laneAccountId === ID_B)?.active).toBe(true)
    })

    // MP (rev 5's watermark bug shape): switching BACK to the first login must also apply.
    it('switching back to the first login also applies rather than no-opping', async () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      plantAccount(laneDir, ID_B, 'b@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [
        indexRow(ID_A, 'a@x.com', true),
        indexRow(ID_B, 'b@x.com', false)
      ])

      await selectLaneAccount(laneDir, 'lane-1', ID_B)
      await selectLaneAccount(laneDir, 'lane-1', ID_A)

      expect(JSON.parse(readFileSync(join(laneDir, '.credentials.json'), 'utf-8'))).toEqual(
        JSON.parse(CREDENTIALS('a@x.com'))
      )
    })

    it('holds the switch gate open only for its own lane', async () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com', false)])

      const applied = selectLaneAccount(laneDir, 'lane-exclusive', ID_A)
      // Cannot observe mid-flight easily since the writer resolves synchronously in-process for
      // this fixture; assert the gate is released once the promise settles and was never left
      // stuck open for an UNRELATED lane at any point.
      expect(isClaudeAuthSwitchInProgress('some-other-lane')).toBe(false)
      await applied
      expect(isClaudeAuthSwitchInProgress('lane-exclusive')).toBe(false)
    })

    it('refuses account_unknown for an id with no index row, writing nothing', async () => {
      const before = existsSync(join(laneDir, '.credentials.json'))

      const error = await selectLaneAccount(laneDir, 'lane-1', ID_A).catch((thrown) => thrown)

      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.account_unknown')
      expect(existsSync(join(laneDir, '.credentials.json'))).toBe(before)
    })

    // MP: an index row with no matching directory (a dangling row) must not be trusted either.
    it('refuses account_unknown for a row whose directory is missing', async () => {
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com')])

      const error = await selectLaneAccount(laneDir, 'lane-1', ID_A).catch((thrown) => thrown)

      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.account_unknown')
    })

    /**
     * "Selection only rewrites... inside the CALLER-SUPPLIED `serializeLaneWrite` turn... do not
     * open a turn yourself" (S9-L1 B2). This is the compatibility test that proves `selectLaneAccount`
     * is safe to be the function such a caller queues: two selects issued back-to-back through the
     * SAME lane's queue apply strictly in order, never interleaved, mirroring FILE 3's "three
     * members, one queue" fixture ahead of the session slice that will actually open the turn.
     */
    it('applies in queue order when the caller serializes two selects through one queue', async () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      plantAccount(laneDir, ID_B, 'b@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [
        indexRow(ID_A, 'a@x.com', true),
        indexRow(ID_B, 'b@x.com', false)
      ])
      const authState = new LaneAuthState()
      const order: string[] = []

      const first = authState.serializeLaneWrite('lane-1', async () => {
        order.push('start-a')
        await selectLaneAccount(laneDir, 'lane-1', ID_B)
        order.push('end-a')
      })
      const second = authState.serializeLaneWrite('lane-1', async () => {
        order.push('start-b')
        await selectLaneAccount(laneDir, 'lane-1', ID_A)
        order.push('end-b')
      })
      await Promise.all([first, second])

      expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
      // The second select ran last, so it is what the lane's credential reflects.
      expect(JSON.parse(readFileSync(join(laneDir, '.credentials.json'), 'utf-8'))).toEqual(
        JSON.parse(CREDENTIALS('a@x.com'))
      )
    })
  })

  describe('removeLaneAccount', () => {
    it('refuses to remove the active login outside a logout', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com', true)])

      const error = (() => {
        try {
          removeLaneAccount(laneDir, ID_A)
          return null
        } catch (thrown) {
          return thrown
        }
      })()

      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.account_active')
      expect(existsSync(join(laneDir, 'claude-accounts', ID_A))).toBe(true)
    })

    it('removes the active login when the lane is being logged out', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com', true)])

      removeLaneAccount(laneDir, ID_A, { loggingOut: true })

      expect(existsSync(join(laneDir, 'claude-accounts', ID_A))).toBe(false)
      expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
    })

    it('removes a non-active login and drops its row', () => {
      plantAccount(laneDir, ID_A, 'a@x.com')
      plantAccount(laneDir, ID_B, 'b@x.com')
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [
        indexRow(ID_A, 'a@x.com', true),
        indexRow(ID_B, 'b@x.com', false)
      ])

      removeLaneAccount(laneDir, ID_B)

      expect(existsSync(join(laneDir, 'claude-accounts', ID_B))).toBe(false)
      const rows = readLaneAccountIndex(join(laneDir, 'claude-accounts'))
      expect(rows.map((r) => r.laneAccountId)).toEqual([ID_A])
    })

    it('refuses account_unknown for an id with no row', () => {
      expect(() => removeLaneAccount(laneDir, ID_A)).toThrow(/account/)
    })
  })

  describe('store cap', () => {
    it('allows up to MAX_LANE_LOGINS and refuses the next', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      const rows = Array.from({ length: MAX_LANE_LOGINS }, (_, i) =>
        indexRow(`${i}${'0'.repeat(7)}-0000-4000-8000-000000000000`, `u${i}@x.com`)
      )
      writeLaneAccountIndex(accountsRoot, rows)

      expect(() => assertLaneAccountStoreHasRoom(laneDir)).toThrow(/maximum/)
      const error = (() => {
        try {
          assertLaneAccountStoreHasRoom(laneDir)
          return null
        } catch (thrown) {
          return thrown
        }
      })()
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe('accounts.lane.login_store_full')
    })

    it('allows room below the cap', () => {
      writeLaneAccountIndex(join(laneDir, 'claude-accounts'), [indexRow(ID_A, 'a@x.com')])

      expect(() => assertLaneAccountStoreHasRoom(laneDir)).not.toThrow()
    })
  })

  // MP target: `listLaneAccounts` must never fall back to a directory WALK, however tempting —
  // an unreadable index costs THIS lane its listing, never a phantom entry the host cannot vouch
  // for. A complete, correctly-marked, correctly-credentialed directory sits on disk here and
  // must still be invisible while the index that would name it cannot be read.
  it('never walks the directory when the index is unreadable, even with a complete account on disk', () => {
    plantAccount(laneDir, ID_A, 'a@x.com')
    writeFileSync(join(laneDir, 'claude-accounts', 'index.json'), 'not json at all')

    expect(listLaneAccounts(laneDir)).toEqual([])
  })

  // A quarantined name is not a v4 UUID; the containment helper still resolves it as an ordinary
  // one-level entry so purge/removal can act on it, but it is refused if it is a symlink.
  describe('resolveContainedLaneAccountEntry', () => {
    it('resolves an ordinary one-level directory entry', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(join(accountsRoot, `${ID_A}.quarantined-1`), { recursive: true })

      expect(resolveContainedLaneAccountEntry(accountsRoot, `${ID_A}.quarantined-1`)).toBe(
        join(accountsRoot, `${ID_A}.quarantined-1`)
      )
    })

    it('refuses a symlinked entry', () => {
      const outside = join(tmpdir(), `orca-contained-escape-${Date.now()}`)
      mkdirSync(outside, { recursive: true })
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(accountsRoot, { recursive: true })
      symlinkSync(outside, join(accountsRoot, ID_A))

      try {
        expect(resolveContainedLaneAccountEntry(accountsRoot, ID_A)).toBeNull()
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('refuses the root itself named as an entry', () => {
      const accountsRoot = join(laneDir, 'claude-accounts')
      mkdirSync(accountsRoot, { recursive: true })

      expect(resolveContainedLaneAccountEntry(accountsRoot, '.')).toBeNull()
    })
  })
})
