import { describe, expect, it } from 'vitest'
import {
  describeAuthorizeUrlRejection,
  isRelayableAuthorizeUrl
} from './claude-authorize-url-policy'

function authorizeUrl(host: string, path: string, redirect: string): string {
  return `https://${host}${path}?client_id=abc&redirect_uri=${encodeURIComponent(redirect)}`
}

const GOOD_REDIRECT = 'https://platform.claude.com/oauth/code/callback'

describe('isRelayableAuthorizeUrl — the allow-list matrix', () => {
  const hosts = ['claude.com', 'claude.ai', 'platform.claude.com']
  const paths = ['/oauth/authorize', '/cai/oauth/authorize']

  for (const host of hosts) {
    for (const path of paths) {
      it(`accepts ${host}${path} with a platform.claude.com redirect`, () => {
        expect(isRelayableAuthorizeUrl(authorizeUrl(host, path, GOOD_REDIRECT))).toBe(true)
      })
    }
  }

  // Design §2/§5 (R-32b): the redirect host is `platform.claude.com` and nothing else. A host with
  // no build or design provenance — console.anthropic.com is in neither 2.1.250's strings nor the
  // design — is not allow-listed as a guess.
  it('refuses a redirect_uri hosted on console.anthropic.com (no observed build or design names it)', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl(
          'claude.com',
          '/cai/oauth/authorize',
          'https://console.anthropic.com/oauth/code/callback'
        )
      )
    ).toBe(false)
  })

  it('refuses console.anthropic.com as the authorize origin for the same reason', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl('console.anthropic.com', '/oauth/authorize', GOOD_REDIRECT)
      )
    ).toBe(false)
  })

  it('refuses a URL with no redirect_uri at all', () => {
    expect(isRelayableAuthorizeUrl('https://claude.com/cai/oauth/authorize')).toBe(false)
  })

  it('refuses a string that does not parse as a URL', () => {
    expect(isRelayableAuthorizeUrl('not a url at all')).toBe(false)
  })
})

describe('isRelayableAuthorizeUrl — each rejected class', () => {
  // P1: an attacker-hosted origin with a well-formed, correct redirect_uri.
  it('refuses a host outside the allow-list (P1)', () => {
    expect(
      isRelayableAuthorizeUrl(authorizeUrl('evil.example.com', '/oauth/authorize', GOOD_REDIRECT))
    ).toBe(false)
  })

  // MP: the class this whole module exists to catch — the closest-looking non-member.
  it('refuses a subdomain-suffix lookalike of an allow-listed host', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl('platform.claude.com.evil.com', '/oauth/authorize', GOOD_REDIRECT)
      )
    ).toBe(false)
  })

  it('refuses userinfo smuggled into an otherwise-correct origin', () => {
    const url = `https://user:pass@claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    expect(isRelayableAuthorizeUrl(url)).toBe(false)
  })

  // MP: `allowedHosts.includes(hostname)` (exact equality) is what rejects these; an
  // `allowedHosts.some((h) => hostname.endsWith(h))` weakening would accept every one of them —
  // a subdomain-suffix lookalike of an allow-listed host, not merely the allow-listed host with
  // something appended after it (that shape is covered above by "*.evil.com").
  it('refuses a hostname that merely ENDS WITH an allow-listed host (suffix, not subdomain)', () => {
    expect(
      isRelayableAuthorizeUrl(authorizeUrl('notclaude.com', '/oauth/authorize', GOOD_REDIRECT))
    ).toBe(false)
  })

  it('refuses a subdomain lookalike that is not itself the allow-listed host', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl('evilplatform.claude.com', '/oauth/authorize', GOOD_REDIRECT)
      )
    ).toBe(false)
  })

  it('refuses a TLD lookalike sharing an allow-listed host as a suffix', () => {
    expect(
      isRelayableAuthorizeUrl(authorizeUrl('xclaude.ai', '/oauth/authorize', GOOD_REDIRECT))
    ).toBe(false)
  })

  it('refuses a redirect_uri host that is a subdomain lookalike of an allow-listed redirect host', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl(
          'claude.com',
          '/cai/oauth/authorize',
          'https://evil-console.anthropic.com/oauth/code/callback'
        )
      )
    ).toBe(false)
  })

  // MP: reading only .hostname (ignoring .username/.password) would accept this.
  it('mutation proof: a hostname-only check would accept the userinfo-smuggled URL above', () => {
    const url = `https://user:pass@claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    const parsed = new URL(url)
    const hostnameOnlyWouldAccept =
      parsed.hostname === 'claude.com' && parsed.pathname === '/cai/oauth/authorize'
    expect(hostnameOnlyWouldAccept).toBe(true) // ...the naive check is fooled...
    expect(isRelayableAuthorizeUrl(url)).toBe(false) // ...the shipped guard is not.
  })

  it('refuses an explicit non-default port', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com:8443/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  it('accepts the explicit default https port (443) — normalises to no port, not a rejection', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com:443/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(true)
  })

  it('an uppercase host normalises to the lower-case allow-listed entry and is accepted', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://CLAUDE.COM/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(true)
  })

  it('refuses a trailing-dot FQDN variant of an allow-listed host', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com./cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  it('refuses a double-slash path that is not the exact allow-listed pathname', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com//cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  // An unencoded traversal segment is dot-segment-normalized by URL parsing itself; either it
  // collapses to something off the allow-list (refused) or to the real endpoint (accepted) —
  // never to a bypass. This fixture collapses OFF the allow-list.
  it('refuses a path-traversal segment that resolves off the allow-list', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com/cai/oauth/authorize/../../admin?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  // P2e: the endpoint itself must be pinned, not any path on the host.
  it('refuses a well-formed URL on an unexpected pathname (P2e)', () => {
    expect(
      isRelayableAuthorizeUrl(
        `https://claude.com/anything/at/all?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  // P-http: the scheme itself must be https.
  it('refuses a plaintext http origin (P-http)', () => {
    expect(
      isRelayableAuthorizeUrl(
        `http://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
      )
    ).toBe(false)
  })

  // P2d: a duplicate redirect_uri must refuse outright, not validate only the first occurrence.
  it('refuses a URL carrying more than one redirect_uri (P2d)', () => {
    const duplicated = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(
      GOOD_REDIRECT
    )}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
    expect(isRelayableAuthorizeUrl(duplicated)).toBe(false)
  })

  // MP: reading redirect_uri via `.get()` (first occurrence only) would accept the duplicate above.
  it('mutation proof: reading only the first redirect_uri accepts the duplicate above', () => {
    const duplicated = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(
      GOOD_REDIRECT
    )}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
    const parsed = new URL(duplicated)
    expect(parsed.searchParams.get('redirect_uri')).toBe(GOOD_REDIRECT)
    expect(isRelayableAuthorizeUrl(duplicated)).toBe(false)
  })

  // P-foreign-redirect: correct origin, but redirect_uri points somewhere off the redirect allow-list.
  it('refuses a redirect_uri whose host is not on the redirect allow-list', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl('claude.com', '/cai/oauth/authorize', 'https://evil.example.com/cb')
      )
    ).toBe(false)
  })

  it('refuses a redirect_uri whose host is a localhost loopback', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl('claude.com', '/cai/oauth/authorize', 'http://localhost:54231/callback')
      )
    ).toBe(false)
  })

  // P2 downgrade: only the redirect_uri scheme is downgraded; hostname comparison alone would miss this.
  it('refuses a redirect_uri downgraded from https to http (P2)', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl(
          'claude.com',
          '/cai/oauth/authorize',
          'http://platform.claude.com/oauth/code/callback'
        )
      )
    ).toBe(false)
  })

  it('refuses a redirect_uri on the right host but the wrong pathname', () => {
    expect(
      isRelayableAuthorizeUrl(
        authorizeUrl(
          'claude.com',
          '/cai/oauth/authorize',
          'https://platform.claude.com/anything/else'
        )
      )
    ).toBe(false)
  })

  it('refuses a redirect_uri that does not parse as a URL', () => {
    const url = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent('not a url')}`
    expect(isRelayableAuthorizeUrl(url)).toBe(false)
  })
})

describe('describeAuthorizeUrlRejection', () => {
  it('names the observed hostname', () => {
    expect(describeAuthorizeUrlRejection('https://evil.example.com/oauth/authorize')).toBe(
      'its host was "evil.example.com"'
    )
  })

  it('never includes the query string or any code/state value', () => {
    const description = describeAuthorizeUrlRejection(
      'https://evil.example.com/oauth/authorize?code=SECRET-CODE&state=SECRET-STATE'
    )
    expect(description).not.toContain('SECRET-CODE')
    expect(description).not.toContain('SECRET-STATE')
    expect(description).not.toContain('?')
  })

  it('names no hostname for text that does not parse as a URL at all', () => {
    expect(describeAuthorizeUrlRejection('not a url at all')).not.toContain('host was')
  })

  // Regression: the pre-fix sentence blamed the AUTHORIZE URL's own host for every rejection,
  // even when that host was allow-listed and the real problem was the redirect_uri — the loopback
  // redirect Orca's OTHER url builder emits is exactly this shape (claude.com, allow-listed;
  // redirect_uri -> localhost, not allow-listed).
  it('does not blame the authorize host when the authorize origin is allow-listed and the redirect_uri is the problem', () => {
    const url = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent('http://localhost:54231/callback')}`
    const description = describeAuthorizeUrlRejection(url)
    expect(description).not.toBe('its host was "claude.com"')
    expect(description).not.toContain('claude.com')
    expect(description).toContain('localhost')
  })

  it('names the redirect_uri host, not the authorize host, when the redirect origin is off the allow-list', () => {
    const url = authorizeUrl('claude.com', '/cai/oauth/authorize', 'https://evil.example.com/cb')
    expect(describeAuthorizeUrlRejection(url)).toContain('evil.example.com')
  })

  it('names a redirect_uri-count problem distinctly, not as a host', () => {
    const duplicated = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(
      GOOD_REDIRECT
    )}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
    expect(describeAuthorizeUrlRejection(duplicated)).not.toContain('host was')
  })

  // Each failed check names ITSELF. An allow-listed host is never blamed for a scheme, port or
  // path failure, and the redirect sentence names the redirect's own failing check.
  it('names an explicit port, not the (allow-listed) host, as the cause', () => {
    const description = describeAuthorizeUrlRejection(
      `https://claude.com:8443/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    )
    expect(description).toBe('its host "claude.com" named an explicit port')
  })

  it('names a plaintext scheme as the cause, without blaming the host', () => {
    const description = describeAuthorizeUrlRejection(
      `http://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    )
    expect(description).toBe('it was not an https address')
  })

  it('names an unexpected pathname as the cause, not the host', () => {
    const description = describeAuthorizeUrlRejection(
      `https://claude.com/anything?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    )
    expect(description).toBe('its path on "claude.com" was not Claude\'s authorization endpoint')
  })

  it('names smuggled userinfo as the cause when the host itself is allow-listed', () => {
    const description = describeAuthorizeUrlRejection(
      `https://user:pw@claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    )
    expect(description).toBe('it carried a user name or password in front of its host')
  })

  it('names the foreign host, not the userinfo, when userinfo fronts a foreign host', () => {
    const description = describeAuthorizeUrlRejection(
      `https://claude.com@evil.example.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(GOOD_REDIRECT)}`
    )
    expect(description).toBe('its host was "evil.example.com"')
  })

  it('names a plaintext redirect scheme as the cause, not the (allow-listed) redirect host', () => {
    const description = describeAuthorizeUrlRejection(
      authorizeUrl(
        'claude.com',
        '/cai/oauth/authorize',
        'http://platform.claude.com/oauth/code/callback'
      )
    )
    expect(description).toBe('the redirect address inside it was not https')
  })

  it('names a wrong redirect pathname distinctly from a wrong redirect host', () => {
    const description = describeAuthorizeUrlRejection(
      authorizeUrl('claude.com', '/cai/oauth/authorize', 'https://platform.claude.com/other')
    )
    expect(description).toBe(
      'the redirect address inside it pointed at "platform.claude.com" but not at the callback path'
    )
  })

  // Pins the exact redirect-host wording so a re-wording to `its host was "localhost"` cannot pass,
  // and pins that a foreign redirect host is named as the host even when its scheme is also wrong.
  it('the redirect-host sentence is the redirect sentence verbatim, never the authorize-host one', () => {
    const url = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent('http://localhost:54231/callback')}`
    expect(describeAuthorizeUrlRejection(url)).toBe(
      'the redirect address inside it pointed at "localhost"'
    )
  })

  // MP: reverting to "always report the authorize URL's own hostname" (the pre-fix shape) would
  // report "claude.com" here instead of the actual offending redirect host.
  it('mutation proof: reporting the authorize URL hostname unconditionally would say "claude.com" here, not the real cause', () => {
    const url = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent('http://localhost:54231/callback')}`
    const parsed = new URL(url)
    const unconditionalHostReport = `its host was "${parsed.hostname}"`
    expect(unconditionalHostReport).toBe('its host was "claude.com"') // ...the old shape's wrong answer...
    expect(describeAuthorizeUrlRejection(url)).not.toBe(unconditionalHostReport) // ...the fix disagrees.
  })
})
