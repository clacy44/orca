import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import {
  LaneCredentialWriter,
  type WindowsLanePublishOps,
  hasClaudeOauthAccessToken,
  readJsonObjectFile,
  writeCredentialsFileAtomically,
  writeOauthAccountIntoConfigFile
} from './lane-credential-writer'

const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })

describe('lane credential writer', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-lane-writer-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('hasClaudeOauthAccessToken', () => {
    it('accepts a blob carrying a non-empty claudeAiOauth.accessToken', () => {
      expect(hasClaudeOauthAccessToken(CREDENTIALS)).toBe(true)
    })

    it.each([
      ['no oauth block', JSON.stringify({ other: true })],
      ['a null oauth block', JSON.stringify({ claudeAiOauth: null })],
      ['an array oauth block', JSON.stringify({ claudeAiOauth: [] })],
      ['no access token', JSON.stringify({ claudeAiOauth: { refreshToken: 'rt' } })],
      ['a blank access token', JSON.stringify({ claudeAiOauth: { accessToken: '   ' } })],
      ['a non-string access token', JSON.stringify({ claudeAiOauth: { accessToken: 7 } })],
      ['a top-level array', JSON.stringify([{ claudeAiOauth: { accessToken: 'at' } }])],
      ['unparseable bytes', '{not json']
    ])('refuses %s', (_label, candidate) => {
      expect(hasClaudeOauthAccessToken(candidate)).toBe(false)
    })
  })

  it('creates missing parents and writes credentials owner-only', () => {
    const target = join(root, 'nested', 'lane', '.credentials.json')
    expect(writeCredentialsFileAtomically(target, CREDENTIALS)).toBe(CREDENTIALS)
    expect(readFileSync(target, 'utf-8')).toBe(CREDENTIALS)
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  })

  it('restores owner-only mode on an unchanged rewrite', () => {
    const target = join(root, '.credentials.json')
    writeCredentialsFileAtomically(target, CREDENTIALS)
    if (process.platform !== 'win32') {
      writeFileSync(target, CREDENTIALS, { mode: 0o644 })
      writeCredentialsFileAtomically(target, CREDENTIALS)
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  })

  it('leaves the file in place on an unchanged rewrite and replaces it on a changed one', () => {
    const target = join(root, '.credentials.json')
    writeCredentialsFileAtomically(target, CREDENTIALS)
    const originalInode = statSync(target).ino
    writeCredentialsFileAtomically(target, CREDENTIALS)
    // The skip is what keeps a live Claude's open handle from meeting a rename (#1507).
    expect(statSync(target).ino).toBe(originalInode)
    // Negative control: different bytes must publish through the atomic rename.
    const changed = JSON.stringify({ claudeAiOauth: { accessToken: 'at2', refreshToken: 'rt2' } })
    writeCredentialsFileAtomically(target, changed)
    expect(readFileSync(target, 'utf-8')).toBe(changed)
    expect(statSync(target).ino).not.toBe(originalInode)
  })

  it('writes identical bytes into every lane it is given', async () => {
    const writer = new LaneCredentialWriter()
    const laneA = mkdtempSync(join(root, 'a-'))
    const laneB = mkdtempSync(join(root, 'b-'))
    await writer.writeCredentials(laneA, CREDENTIALS)
    // Negative control: an identical earlier write in lane A must not suppress lane B's.
    await writer.writeCredentials(laneB, CREDENTIALS)
    expect(readFileSync(join(laneA, '.credentials.json'), 'utf-8')).toBe(CREDENTIALS)
    expect(readFileSync(join(laneB, '.credentials.json'), 'utf-8')).toBe(CREDENTIALS)
  })

  describe('the win32 publish arm', () => {
    // The two primitives are injected, so the §2m(2) sequence is asserted on every platform;
    // only the real ACL script and the real rename retry stay Windows-only.
    const windowsWriter = (
      ops: Partial<WindowsLanePublishOps> = {}
    ): { writer: LaneCredentialWriter; restricted: string[] } => {
      const restricted: string[] = []
      const writer = new LaneCredentialWriter({
        platform: 'win32',
        windows: {
          restrictPath: (targetPath) => {
            restricted.push(targetPath)
            return true
          },
          publish: renameFileWithWindowsRetry,
          ...ops
        }
      })
      return { writer, restricted }
    }

    it('restricts the temp file before publishing and verifies the published path', async () => {
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const target = join(laneDir, '.credentials.json')
      const { writer, restricted } = windowsWriter()
      await writer.writeCredentials(laneDir, CREDENTIALS)
      expect(readFileSync(target, 'utf-8')).toBe(CREDENTIALS)
      expect(restricted).toHaveLength(2)
      expect(restricted[0].startsWith(`${target}.`)).toBe(true)
      expect(restricted[0].endsWith('.tmp')).toBe(true)
      expect(restricted[1]).toBe(target)
    })

    it('refuses the push when the temp file DACL does not verify, and publishes nothing', async () => {
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const { writer } = windowsWriter({ restrictPath: () => false })
      await expect(writer.writeCredentials(laneDir, CREDENTIALS)).rejects.toMatchObject({
        code: 'accounts.lane.switch_write_failed'
      })
      expect(existsSync(join(laneDir, '.credentials.json'))).toBe(false)
      // And no full-credential temp is left at rest.
      expect(readdirSync(laneDir)).toEqual([])
    })

    it('refuses the push when the PUBLISHED path fails verification', async () => {
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const target = join(laneDir, '.credentials.json')
      const { writer } = windowsWriter({ restrictPath: (path) => path !== target })
      // The bytes have landed, so the refusal is what stops the caller reporting a lane the
      // host cannot vouch for.
      await expect(writer.writeCredentials(laneDir, CREDENTIALS)).rejects.toMatchObject({
        code: 'accounts.lane.switch_write_failed'
      })
    })

    it('refuses a target another process holds open, leaving the lane byte-identical', async () => {
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const target = join(laneDir, '.credentials.json')
      writeFileSync(target, 'existing-credential')
      const { writer } = windowsWriter({
        publish: () => {
          const error: NodeJS.ErrnoException = new Error('EBUSY')
          error.code = 'EBUSY'
          throw error
        }
      })
      await expect(writer.writeCredentials(laneDir, CREDENTIALS)).rejects.toMatchObject({
        code: 'accounts.lane.switch_write_locked'
      })
      expect(readFileSync(target, 'utf-8')).toBe('existing-credential')
      expect(readdirSync(laneDir)).toEqual(['.credentials.json'])
    })

    it('lets an unrelated write error through untranslated', async () => {
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const { writer } = windowsWriter({
        publish: () => {
          const error: NodeJS.ErrnoException = new Error('ENOSPC')
          error.code = 'ENOSPC'
          throw error
        }
      })
      // Negative control: only the three contention codes become the locked refusal.
      await expect(writer.writeCredentials(laneDir, CREDENTIALS)).rejects.toThrow('ENOSPC')
    })
  })

  describe('the darwin Keychain arm', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

    const setPlatform = (platform: NodeJS.Platform): void => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    }

    afterEach(() => {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    })

    it('pairs the lane-scoped Keychain item with the lane file', async () => {
      setPlatform('darwin')
      const keychain = vi.fn(async () => {})
      const laneDir = mkdtempSync(join(root, 'lane-'))
      await new LaneCredentialWriter({ writeKeychain: keychain }).writeCredentials(
        laneDir,
        CREDENTIALS
      )
      // Scoped by the LANE dir: the CLI reads that service, and the file alone leaves the
      // Keychain item on the revoked token.
      expect(keychain).toHaveBeenCalledWith(CREDENTIALS, laneDir)
      expect(readFileSync(join(laneDir, '.credentials.json'), 'utf-8')).toBe(CREDENTIALS)
    })

    it('surfaces a failed Keychain write instead of reporting the lane written', async () => {
      setPlatform('darwin')
      const laneDir = mkdtempSync(join(root, 'lane-'))
      const writer = new LaneCredentialWriter({
        writeKeychain: async () => {
          throw new Error('keychain refused')
        }
      })
      await expect(writer.writeCredentials(laneDir, CREDENTIALS)).rejects.toThrow(
        'keychain refused'
      )
    })

    it('writes no Keychain item on the other platforms', async () => {
      setPlatform('linux')
      const keychain = vi.fn(async () => {})
      const laneDir = mkdtempSync(join(root, 'lane-'))
      await new LaneCredentialWriter({ writeKeychain: keychain }).writeCredentials(
        laneDir,
        CREDENTIALS
      )
      expect(keychain).not.toHaveBeenCalled()
    })
  })

  it('merges and deletes oauthAccount without erasing the rest of the config', () => {
    const configPath = join(root, '.claude.json')
    writeFileSync(configPath, JSON.stringify({ keep: 1, oauthAccount: { accountUuid: 'old' } }))
    expect(writeOauthAccountIntoConfigFile(configPath, { accountUuid: 'new' })).toBe(true)
    expect(readJsonObjectFile(configPath)).toEqual({
      keep: 1,
      oauthAccount: { accountUuid: 'new' }
    })
    expect(writeOauthAccountIntoConfigFile(configPath, null)).toBe(true)
    expect(readJsonObjectFile(configPath)).toEqual({ keep: 1 })
  })

  it('refuses to rewrite an unparseable config rather than erasing it', () => {
    const configPath = join(root, '.claude.json')
    writeFileSync(configPath, 'not json at all')
    expect(readJsonObjectFile(configPath)).toBeNull()
    expect(writeOauthAccountIntoConfigFile(configPath, { accountUuid: 'new' })).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).toBe('not json at all')
  })

  it('treats an absent config as empty so a first write can seed it', () => {
    const configPath = join(root, 'fresh', '.claude.json')
    expect(readJsonObjectFile(configPath)).toEqual({})
    expect(writeOauthAccountIntoConfigFile(configPath, { accountUuid: 'a' })).toBe(true)
    expect(readJsonObjectFile(configPath)).toEqual({ oauthAccount: { accountUuid: 'a' } })
  })
})
