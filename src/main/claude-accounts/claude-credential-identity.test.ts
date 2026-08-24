import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  compareRefreshTokens,
  hashRefreshToken,
  readFreshnessFromCredentials,
  readIdentityFromCredentials,
  readIdentityFromOauthAccount,
  readRefreshTokenFromCredentials,
  readRefreshTokenSha256
} from './claude-credential-identity'

const withOauth = (oauth: Record<string, unknown>): string =>
  JSON.stringify({ claudeAiOauth: oauth })

describe('claude credential identity', () => {
  it('reads the credentials spelling of the three identity fields', () => {
    expect(
      readIdentityFromCredentials(
        withOauth({ accountId: ' acc ', email: 'a@b.c', organizationId: 'org' })
      )
    ).toEqual({ accountUuid: 'acc', email: 'a@b.c', organizationUuid: 'org' })
  })

  it('reads the oauth-account spelling, which is not the credentials one', () => {
    expect(readIdentityFromOauthAccount({ accountUuid: 'acc', emailAddress: 'a@b.c' })).toEqual({
      accountUuid: 'acc',
      email: 'a@b.c',
      organizationUuid: null
    })
  })

  it('returns null for unparseable credentials and a blank identity for a missing block', () => {
    expect(readIdentityFromCredentials('{nope')).toBeNull()
    expect(readIdentityFromCredentials('{}')).toEqual({
      accountUuid: null,
      email: null,
      organizationUuid: null
    })
  })

  it('distinguishes a missing refresh token from a rotated one', () => {
    const left = withOauth({ refreshToken: 'one' })
    const right = withOauth({ refreshToken: 'two' })
    const none = withOauth({ accessToken: 'at' })
    expect(compareRefreshTokens(left, left)).toBe('same')
    expect(compareRefreshTokens(left, right)).toBe('different')
    // Negative control: a lane with no token has not "rotated", and must not read as different.
    expect(compareRefreshTokens(left, none)).toBe('missing')
    expect(compareRefreshTokens(none, none)).toBe('missing')
    expect(compareRefreshTokens('{nope', left)).toBe('missing')
  })

  it('trims a refresh token before comparing or hashing it', () => {
    expect(readRefreshTokenFromCredentials(withOauth({ refreshToken: '  rt  ' }))).toBe('rt')
    expect(readRefreshTokenFromCredentials(withOauth({ refreshToken: '   ' }))).toBeNull()
    expect(
      compareRefreshTokens(withOauth({ refreshToken: ' rt' }), withOauth({ refreshToken: 'rt ' }))
    ).toBe('same')
  })

  it('hashes the refresh token rather than carrying it', () => {
    const sha = readRefreshTokenSha256(withOauth({ refreshToken: 'secret-token' }))
    expect(sha).toBe(createHash('sha256').update('secret-token', 'utf-8').digest('hex'))
    expect(sha).not.toContain('secret-token')
    expect(sha).toBe(hashRefreshToken('secret-token'))
    expect(readRefreshTokenSha256(withOauth({}))).toBeNull()
  })

  it('reads expiry under every spelling the CLI has used', () => {
    expect(readFreshnessFromCredentials(withOauth({ expiresAt: 10 }))).toBe(10)
    expect(readFreshnessFromCredentials(withOauth({ expires_at: 11 }))).toBe(11)
    expect(readFreshnessFromCredentials(withOauth({ expiry: '12' }))).toBe(12)
    expect(readFreshnessFromCredentials(withOauth({ expires: 13 }))).toBe(13)
    expect(readFreshnessFromCredentials(withOauth({ expiresAt: 'later' }))).toBeNull()
    expect(readFreshnessFromCredentials('{nope')).toBeNull()
  })
})
