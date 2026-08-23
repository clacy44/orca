import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LANE_PUSH_MEMBER_MAX_BYTES, parseLanePushRequest } from './lane-push-envelope'

const CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 10_000 }
})
const OAUTH_ACCOUNT = JSON.stringify({ accountUuid: 'acct-1', emailAddress: 'ana@example.com' })

const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  envelope: { credentialsJson: CREDENTIALS, oauthAccountJson: OAUTH_ACCOUNT },
  basedOnRefreshTokenSha256: null,
  delegation: {
    hostId: 'host-1',
    principalId: 'principal-1',
    delegatedGrantId: 'device-a',
    since: 1
  },
  ...overrides
})

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('lane push envelope validation', () => {
  it('accepts the three-member envelope and parses the oauth account once', () => {
    const parsed = parseLanePushRequest(request({ ...request(), reauthenticated: true }))
    expect(parsed.envelope.displayName).toBeNull()
    expect(parsed.oauthAccount).toEqual({ accountUuid: 'acct-1', emailAddress: 'ana@example.com' })
    expect(parsed.reauthenticated).toBe(true)
  })

  it('keeps a bounded printable displayName', () => {
    const parsed = parseLanePushRequest(
      request({
        envelope: {
          credentialsJson: CREDENTIALS,
          oauthAccountJson: OAUTH_ACCOUNT,
          displayName: '  Work  '
        }
      })
    )
    expect(parsed.envelope.displayName).toBe('Work')
  })

  it('refuses a fourth envelope member', () => {
    expect(
      refusalCode(() =>
        parseLanePushRequest(
          request({
            envelope: {
              credentialsJson: CREDENTIALS,
              oauthAccountJson: OAUTH_ACCOUNT,
              settingsJson: '{}'
            }
          })
        )
      )
    ).toBe('accounts.lane.push_malformed')
  })

  it('refuses an oversized member by BYTES, and accepts one exactly at the bound', () => {
    const pad = (bytes: number): string =>
      JSON.stringify({
        claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1' },
        pad: 'x'.repeat(bytes)
      })
    const atBound = pad(0).length
    const exactly = pad(LANE_PUSH_MEMBER_MAX_BYTES - atBound)
    expect(exactly.length).toBe(LANE_PUSH_MEMBER_MAX_BYTES)
    expect(() =>
      parseLanePushRequest(
        request({ envelope: { credentialsJson: exactly, oauthAccountJson: OAUTH_ACCOUNT } })
      )
    ).not.toThrow()
    expect(
      refusalCode(() =>
        parseLanePushRequest(
          request({
            envelope: {
              credentialsJson: `${exactly.slice(0, -2)}xx"}`,
              oauthAccountJson: OAUTH_ACCOUNT
            }
          })
        )
      )
    ).toBe('accounts.lane.push_malformed')
  })

  it('counts multi-byte characters as bytes, not as characters', () => {
    const wide = JSON.stringify({
      claudeAiOauth: { accessToken: 'at-1' },
      pad: '€'.repeat(LANE_PUSH_MEMBER_MAX_BYTES / 2)
    })
    expect(wide.length).toBeLessThan(LANE_PUSH_MEMBER_MAX_BYTES)
    expect(
      refusalCode(() =>
        parseLanePushRequest(
          request({ envelope: { credentialsJson: wide, oauthAccountJson: OAUTH_ACCOUNT } })
        )
      )
    ).toBe('accounts.lane.push_malformed')
  })

  it('refuses credentials with no usable access token', () => {
    for (const bad of [
      '{}',
      '{"claudeAiOauth":{}}',
      '{"claudeAiOauth":{"accessToken":"  "}}',
      'x'
    ]) {
      expect(
        refusalCode(() =>
          parseLanePushRequest(
            request({ envelope: { credentialsJson: bad, oauthAccountJson: OAUTH_ACCOUNT } })
          )
        )
      ).toBe('accounts.lane.push_malformed')
    }
  })

  it('refuses a non-object oauth account', () => {
    for (const bad of ['[]', '"ana"', 'null', 'not json']) {
      expect(
        refusalCode(() =>
          parseLanePushRequest(
            request({ envelope: { credentialsJson: CREDENTIALS, oauthAccountJson: bad } })
          )
        )
      ).toBe('accounts.lane.push_malformed')
    }
  })

  it('refuses an over-long or control-character displayName', () => {
    for (const bad of ['x'.repeat(65), `Work${String.fromCharCode(0x1b)}`]) {
      expect(
        refusalCode(() =>
          parseLanePushRequest(
            request({
              envelope: {
                credentialsJson: CREDENTIALS,
                oauthAccountJson: OAUTH_ACCOUNT,
                displayName: bad
              }
            })
          )
        )
      ).toBe('accounts.lane.push_malformed')
    }
  })

  it('refuses a missing or malformed delegation member and a lane-naming parameter', () => {
    expect(refusalCode(() => parseLanePushRequest(request({ delegation: undefined })))).toBe(
      'accounts.lane.push_malformed'
    )
    // No lane parameter exists to spoof: an extra top-level member is refused outright (§2d).
    expect(refusalCode(() => parseLanePushRequest(request({ laneId: 'principal-2' })))).toBe(
      'accounts.lane.push_malformed'
    )
  })

  it('refuses a basedOn sha that is not a sha256', () => {
    expect(
      refusalCode(() => parseLanePushRequest(request({ basedOnRefreshTokenSha256: 'deadbeef' })))
    ).toBe('accounts.lane.push_malformed')
  })

  it('never repeats a credential member back in the refusal message', () => {
    try {
      parseLanePushRequest(
        request({
          envelope: {
            credentialsJson: '{"claudeAiOauth":{"accessToken":""}}',
            oauthAccountJson: '[]'
          }
        })
      )
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('claudeAiOauth')
      expect(String((error as Error).message)).not.toContain('accessToken')
    }
  })
})
