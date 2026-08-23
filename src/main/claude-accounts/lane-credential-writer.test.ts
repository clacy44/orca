import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LaneCredentialWriter,
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
    expect(writeCredentialsFileAtomically(target, CREDENTIALS, null)).toBe(CREDENTIALS)
    expect(readFileSync(target, 'utf-8')).toBe(CREDENTIALS)
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  })

  it('restores owner-only mode on an unchanged rewrite', () => {
    const target = join(root, '.credentials.json')
    writeCredentialsFileAtomically(target, CREDENTIALS, null)
    if (process.platform !== 'win32') {
      writeFileSync(target, CREDENTIALS, { mode: 0o644 })
      writeCredentialsFileAtomically(target, CREDENTIALS, CREDENTIALS)
      expect(statSync(target).mode & 0o777).toBe(0o600)
    }
  })

  it('keeps one last-written cache per lane', () => {
    const writer = new LaneCredentialWriter()
    const laneA = mkdtempSync(join(root, 'a-'))
    const laneB = mkdtempSync(join(root, 'b-'))
    writer.writeCredentials(laneA, CREDENTIALS)
    // Negative control: identical bytes in another lane are NOT remembered as written there.
    expect(writer.lastWrittenCredentials(laneA)).toBe(CREDENTIALS)
    expect(writer.lastWrittenCredentials(laneB)).toBeNull()
    writer.writeCredentials(laneB, CREDENTIALS)
    expect(readFileSync(join(laneB, '.credentials.json'), 'utf-8')).toBe(CREDENTIALS)
    writer.forget(laneA)
    expect(writer.lastWrittenCredentials(laneA)).toBeNull()
    expect(writer.lastWrittenCredentials(laneB)).toBe(CREDENTIALS)
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
