import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getClaudeManagedAccountsRoot,
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'

const state = { userDataDir: '' }

vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }))

const ACCOUNT = 'account-1'

describe('managed Claude auth path containment', () => {
  let root = ''
  let authPath = ''

  beforeEach(() => {
    state.userDataDir = mkdtempSync(join(tmpdir(), 'orca-managed-auth-'))
    root = getClaudeManagedAccountsRoot()
    authPath = join(root, ACCOUNT, 'auth')
    mkdirSync(authPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(state.userDataDir, { recursive: true, force: true })
  })

  const markOwned = (): void => {
    writeFileSync(join(authPath, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
  }

  it('resolves a marked two-segment auth dir under the accounts root', () => {
    markOwned()

    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, authPath)).toBe(authPath)
  })

  it('refuses an unmarked directory', () => {
    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, authPath)).toBeNull()
  })

  it('refuses a symlinked auth dir pointing out of the root', () => {
    const outside = join(state.userDataDir, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
    const linked = join(root, 'account-2', 'auth')
    mkdirSync(join(root, 'account-2'), { recursive: true })
    symlinkSync(outside, linked)

    expect(resolveOwnedClaudeManagedAuthPath('account-2', linked)).toBeNull()
  })

  it('refuses a link that points at the account’s own auth dir rather than following it', () => {
    markOwned()
    const linked = join(root, ACCOUNT, 'legacy')
    symlinkSync(authPath, linked)

    // Whoever owns the link can re-point it between this check and the read that follows.
    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, linked)).toBeNull()
  })

  it('refuses a candidate outside the accounts root', () => {
    const outside = join(state.userDataDir, ACCOUNT, 'auth')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)

    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, outside)).toBeNull()
  })

  it('refuses a child file that is a symlink out of the auth dir', () => {
    markOwned()
    const secret = join(state.userDataDir, 'elsewhere.json')
    writeFileSync(secret, '{"stolen":true}')
    symlinkSync(secret, join(authPath, '.credentials.json'))

    expect(readClaudeManagedAuthFile(authPath, '.credentials.json')).toBeNull()
    expect(() =>
      writeClaudeManagedAuthFile(authPath, '.credentials.json', '{"claudeAiOauth":{}}')
    ).toThrow(/not owned by Orca/)
  })
})

// S9-L1 B1: the injectable `root` option is what lets `<lane>/claude-accounts` share this exact
// discipline instead of a second copy of it (§storeLayout "MIRRORING managed-auth-path.ts").
describe('an injected lane-scoped root', () => {
  let laneAccountsRoot = ''
  let authPath = ''

  beforeEach(() => {
    // A directory the electron mock's userData does NOT point at, so a bug that silently fell
    // back to the desktop default would fail these tests rather than pass them by accident.
    laneAccountsRoot = mkdtempSync(join(tmpdir(), 'orca-lane-accounts-'))
    authPath = join(laneAccountsRoot, ACCOUNT, 'auth')
    mkdirSync(authPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(laneAccountsRoot, { recursive: true, force: true })
  })

  it('resolves a marked two-segment auth dir under the injected root', () => {
    writeFileSync(join(authPath, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)

    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, authPath, { root: laneAccountsRoot })).toBe(
      authPath
    )
  })

  it('refuses an unmarked directory under the injected root', () => {
    expect(
      resolveOwnedClaudeManagedAuthPath(ACCOUNT, authPath, { root: laneAccountsRoot })
    ).toBeNull()
  })

  // Negative control: the same candidate resolves against ITS OWN root but not against the
  // unrelated desktop-managed root the earlier describe block set up, and vice versa — an
  // injected root is not a fallback that widens what a lane can reach.
  it('does not resolve against the desktop-managed root, only its own', () => {
    writeFileSync(join(authPath, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)

    expect(resolveOwnedClaudeManagedAuthPath(ACCOUNT, authPath)).toBeNull()
  })

  // The symlink-escape negative control the lane root needs of its own: a lane-scoped account
  // directory that is actually a link out of the lane's store must refuse exactly as the
  // desktop-managed root does above.
  it('refuses a symlinked lane account dir pointing out of its own root', () => {
    const outside = join(tmpdir(), `orca-lane-escape-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
    const linked = join(laneAccountsRoot, 'account-2', 'auth')
    mkdirSync(join(laneAccountsRoot, 'account-2'), { recursive: true })
    symlinkSync(outside, linked)

    try {
      expect(
        resolveOwnedClaudeManagedAuthPath('account-2', linked, { root: laneAccountsRoot })
      ).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
