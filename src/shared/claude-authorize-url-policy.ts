/**
 * The one allow-list a `claude` CLI login authorize URL — and its `redirect_uri` — must satisfy
 * before Orca will relay it to a person or a client (S9 §2b, §4 R-32b: "whoever chooses which URL
 * a person authenticates against chooses whose lane receives the resulting grant"). Both the host
 * (`lane-login-url-parser.ts`, deciding what to relay from the live login child's stdout) and any
 * client that validates before opening a browser must import and call THIS module rather than
 * keeping their own copy of the hostname/pathname pins — a second copy is exactly how a client and
 * the host end up disagreeing about what is safe.
 *
 * Verified against the installed `claude` binary, version 2.1.250 (`claude --version`), two ways:
 * (1) a live, throwaway `claude auth login --claudeai` run (killed before completion, never
 *     submitted) printed exactly one authorize URL:
 *     `https://claude.com/cai/oauth/authorize?...&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&...`
 * (2) `strings` over the installed binary at
 *     `/home/ubuntu/.local/share/claude/versions/2.1.250` contains exactly two authorize
 *     pathnames — `/oauth/authorize` and `/cai/oauth/authorize` — and exactly one redirect
 *     pathname, `oauth/code/callback`, paired in the binary with `//claude.com/cai/oauth/authorize`
 *     and with `platform.claude.com` elsewhere (also the OAuth token host, `oauth-refresh.ts`).
 *     `console.anthropic.com` does not appear in this build's strings at all — it is allow-listed
 *     here per the S9 design (rev 38) as another legitimate Anthropic authorize/redirect surface
 *     the CLI or a future build may use, not because 2.1.250 was observed emitting it.
 * Re-verify both ways whenever the pinned CLI version bumps (see
 * lane-login-cli-version-gate.ts's LAST_VERIFIED_CLI_VERSION) and update this comment together
 * with that constant — they must never name different builds.
 */

/** Hosts a relayable authorize URL's OWN origin may equal. Checking only `redirect_uri` and not
 * this origin lets an attacker-hosted page carry a well-formed redirect_uri through (P1/P1b). */
const ALLOWED_AUTHORIZE_HOSTS: readonly string[] = [
  'claude.com',
  'claude.ai',
  'platform.claude.com',
  'console.anthropic.com'
]

/** Pathnames a relayable authorize URL's OWN path may equal — the two observed authorize
 * endpoints, not any path on an allow-listed host (P2e). */
const ALLOWED_AUTHORIZE_PATHNAMES: readonly string[] = ['/oauth/authorize', '/cai/oauth/authorize']

/** Hosts a relayable authorize URL's `redirect_uri` query param may itself point at. Anything else
 * (e.g. a `localhost:<ephemeral>` loopback variant the CLI also prints) must never be relayed: a
 * code delivered to an unauthenticated loopback port on the person's own desktop is a plaintext
 * credential leak (MP). */
const ALLOWED_REDIRECT_HOSTS: readonly string[] = ['platform.claude.com', 'console.anthropic.com']

/** The one pathname a relayable `redirect_uri` may have. */
const REQUIRED_REDIRECT_PATHNAME = '/oauth/code/callback'

/**
 * True when `origin` (an authorize URL's own origin, or its `redirect_uri`'s origin — the same
 * shape of check applies to both) is a bare `https:` origin on one of `allowedHosts`, at one of
 * `allowedPathnames`: no userinfo (`user:pass@host` would leave the hostname check passing while
 * routing credentials at parse time to an attacker-controlled sink), no explicit port (a
 * same-host, different-port origin is not the same origin), and hostname compared by exact string
 * equality — which by construction also rejects a trailing-dot FQDN variant
 * (`platform.claude.com.`) and a subdomain-suffix lookalike (`platform.claude.com.evil.com`)
 * without a separate check for either, since WHATWG `URL` already lower-cases a parsed hostname.
 * Pathname is likewise exact-string-compared against the parsed (already dot-segment-normalized)
 * `.pathname`, which is what rejects a `//oauth/authorize` double slash or an unencoded `..`
 * traversal segment (either normalizes to something that is not one of `allowedPathnames`, or
 * collapses harmlessly to one that is).
 */
function isTrustedOrigin(
  url: URL,
  allowedHosts: readonly string[],
  allowedPathnames: readonly string[]
): boolean {
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    allowedHosts.includes(url.hostname) &&
    allowedPathnames.includes(url.pathname)
  )
}

/**
 * True when `url` is a printed (not loopback-callback) Claude authorization URL safe to relay:
 * its own origin passes `isTrustedOrigin` against the authorize allow-list, and it carries EXACTLY
 * ONE `redirect_uri` query parameter (`searchParams.getAll`, not `.get` — reading only the first
 * of two conflicting values is not validating the URL, P2d), itself a `redirect_uri` whose origin
 * passes `isTrustedOrigin` against the redirect allow-list.
 */
export function isRelayableAuthorizeUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!isTrustedOrigin(parsed, ALLOWED_AUTHORIZE_HOSTS, ALLOWED_AUTHORIZE_PATHNAMES)) {
    return false
  }
  const redirectUriValues = parsed.searchParams.getAll('redirect_uri')
  if (redirectUriValues.length !== 1) {
    return false
  }
  let redirect: URL
  try {
    redirect = new URL(redirectUriValues[0])
  } catch {
    return false
  }
  return isTrustedOrigin(redirect, ALLOWED_REDIRECT_HOSTS, [REQUIRED_REDIRECT_PATHNAME])
}

/**
 * Names ONLY the hostname `url` was observed to carry (never its query string, and therefore
 * never an OAuth `code`/`state` value) — safe to fold into a refusal sentence shown to a person.
 * `url` that fails to parse at all names no hostname (there is none to observe).
 */
export function describeAuthorizeUrlRejection(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'the printed text was not a valid URL at all'
  }
  return `its host was "${parsed.hostname}"`
}
