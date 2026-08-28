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
 *     Every entry in the allow-lists below traces to one of those two sources or to the S9 design
 *     (rev 39, §2/§5); a host with no build or design provenance is NOT listed — widening the
 *     allow-list is a deliberate, reviewed change, never a forward-compatibility guess.
 * Re-verify both ways whenever the pinned CLI version bumps (see
 * lane-login-cli-version-gate.ts's LAST_VERIFIED_CLI_VERSION) and update this comment together
 * with that constant — they must never name different builds.
 */

/** Hosts a relayable authorize URL's OWN origin may equal. Checking only `redirect_uri` and not
 * this origin lets an attacker-hosted page carry a well-formed redirect_uri through (P1/P1b). */
const ALLOWED_AUTHORIZE_HOSTS: readonly string[] = [
  'claude.com',
  'claude.ai',
  'platform.claude.com'
]

/** Pathnames a relayable authorize URL's OWN path may equal — the two observed authorize
 * endpoints, not any path on an allow-listed host (P2e). */
const ALLOWED_AUTHORIZE_PATHNAMES: readonly string[] = ['/oauth/authorize', '/cai/oauth/authorize']

/** Hosts a relayable authorize URL's `redirect_uri` query param may itself point at. Anything else
 * (e.g. a `localhost:<ephemeral>` loopback variant the CLI also prints) must never be relayed: a
 * code delivered to an unauthenticated loopback port on the person's own desktop is a plaintext
 * credential leak (MP). */
const ALLOWED_REDIRECT_HOSTS: readonly string[] = ['platform.claude.com']

/** The one pathname a relayable `redirect_uri` may have. */
const REQUIRED_REDIRECT_PATHNAME = '/oauth/code/callback'

/**
 * Names the first check `url` (an authorize URL's own origin, or its `redirect_uri`'s origin — the
 * same shape of check applies to both) fails, or null when it is a bare `https:` origin on one of
 * `allowedHosts`, at one of `allowedPathnames`: no userinfo (`user:pass@host` would leave the hostname check passing while
 * routing credentials at parse time to an attacker-controlled sink), no explicit port (a
 * same-host, different-port origin is not the same origin), and hostname compared by exact string
 * equality — which by construction also rejects a trailing-dot FQDN variant
 * (`platform.claude.com.`) and a subdomain-suffix lookalike (`platform.claude.com.evil.com`)
 * without a separate check for either, since WHATWG `URL` already lower-cases a parsed hostname.
 * Pathname is likewise exact-string-compared against the parsed (already dot-segment-normalized)
 * `.pathname`, which is what rejects a `//oauth/authorize` double slash or an unencoded `..`
 * traversal segment (either normalizes to something that is not one of `allowedPathnames`, or
 * collapses harmlessly to one that is). The host is checked first only so the refusal sentence
 * names the host for a foreign origin (`http://localhost:<port>/callback` reads as "pointed at
 * localhost", not "was not https"); every check must pass regardless of order.
 */
type OriginCheck = 'scheme' | 'userinfo' | 'port' | 'host' | 'pathname'

function failedOriginCheck(
  url: URL,
  allowedHosts: readonly string[],
  allowedPathnames: readonly string[]
): OriginCheck | null {
  if (!allowedHosts.includes(url.hostname)) {
    return 'host'
  }
  if (url.protocol !== 'https:') {
    return 'scheme'
  }
  if (url.username !== '' || url.password !== '') {
    return 'userinfo'
  }
  if (url.port !== '') {
    return 'port'
  }
  if (!allowedPathnames.includes(url.pathname)) {
    return 'pathname'
  }
  return null
}

/** Which check `classifyAuthorizeUrl` failed on — lets a refusal sentence name the actual cause
 * instead of always blaming the authorize URL's own host, which is wrong for every rejection that
 * came from the `redirect_uri` instead (the loopback redirect Orca's OTHER url builder emits is
 * exactly this case: the authorize origin is `claude.com`, allow-listed, and the redirect is not). */
export type AuthorizeUrlRejectionReason =
  | 'unparsable'
  | `authorize_${OriginCheck}`
  | 'redirect_uri_count'
  | 'redirect_uri_unparsable'
  | `redirect_${OriginCheck}`

export type AuthorizeUrlClassification =
  | { ok: true }
  | { ok: false; reason: AuthorizeUrlRejectionReason; hostname: string | null }

/**
 * Single source of truth for both `isRelayableAuthorizeUrl` and `describeAuthorizeUrlRejection` —
 * a second, separately-maintained walk of the same checks is exactly how the two drift apart.
 */
function classifyAuthorizeUrl(url: string): AuthorizeUrlClassification {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'unparsable', hostname: null }
  }
  const authorizeCheck = failedOriginCheck(
    parsed,
    ALLOWED_AUTHORIZE_HOSTS,
    ALLOWED_AUTHORIZE_PATHNAMES
  )
  if (authorizeCheck) {
    return { ok: false, reason: `authorize_${authorizeCheck}`, hostname: parsed.hostname }
  }
  const redirectUriValues = parsed.searchParams.getAll('redirect_uri')
  if (redirectUriValues.length !== 1) {
    return { ok: false, reason: 'redirect_uri_count', hostname: parsed.hostname }
  }
  let redirect: URL
  try {
    redirect = new URL(redirectUriValues[0])
  } catch {
    return { ok: false, reason: 'redirect_uri_unparsable', hostname: parsed.hostname }
  }
  const redirectCheck = failedOriginCheck(redirect, ALLOWED_REDIRECT_HOSTS, [
    REQUIRED_REDIRECT_PATHNAME
  ])
  if (redirectCheck) {
    return { ok: false, reason: `redirect_${redirectCheck}`, hostname: redirect.hostname }
  }
  return { ok: true }
}

/**
 * True when `url` is a printed (not loopback-callback) Claude authorization URL safe to relay:
 * its own origin passes `failedOriginCheck` against the authorize allow-list, and it carries EXACTLY
 * ONE `redirect_uri` query parameter (`searchParams.getAll`, not `.get` — reading only the first
 * of two conflicting values is not validating the URL, P2d), itself a `redirect_uri` whose origin
 * passes `failedOriginCheck` against the redirect allow-list.
 */
export function isRelayableAuthorizeUrl(url: string): boolean {
  return classifyAuthorizeUrl(url).ok
}

/**
 * Names ONLY the hostname(s) `url` was observed to carry (never its query string, and therefore
 * never an OAuth `code`/`state` value) — safe to fold into a refusal sentence shown to a person.
 * Worded from the SAME classification `isRelayableAuthorizeUrl` computes, so the reason named is
 * always the reason the URL actually failed on — never "its host was X" for a rejection that came
 * from `redirect_uri`, where X is an allow-listed host that was never the problem.
 */
export function describeAuthorizeUrlRejection(url: string): string {
  const result = classifyAuthorizeUrl(url)
  if (result.ok) {
    return 'it was in fact safe to relay'
  }
  // Every sentence names the check that failed and, at most, the hostname that failed it —
  // never the query string. A sentence that named an allow-listed host for a scheme, port or
  // path failure would tell the operator the opposite of what happened.
  switch (result.reason) {
    case 'unparsable':
      return 'the printed text was not a valid URL at all'
    case 'authorize_scheme':
      return 'it was not an https address'
    case 'authorize_userinfo':
      return 'it carried a user name or password in front of its host'
    case 'authorize_port':
      return `its host "${result.hostname}" named an explicit port`
    case 'authorize_host':
      return `its host was "${result.hostname}"`
    case 'authorize_pathname':
      return `its path on "${result.hostname}" was not Claude's authorization endpoint`
    case 'redirect_uri_count':
      return 'it did not carry exactly one redirect address'
    case 'redirect_uri_unparsable':
      return 'the redirect address inside it was not a valid URL'
    case 'redirect_scheme':
      return 'the redirect address inside it was not https'
    case 'redirect_userinfo':
      return 'the redirect address inside it carried a user name or password'
    case 'redirect_port':
      return `the redirect address inside it named an explicit port on "${result.hostname}"`
    case 'redirect_host':
      return `the redirect address inside it pointed at "${result.hostname}"`
    case 'redirect_pathname':
      return `the redirect address inside it pointed at "${result.hostname}" but not at the callback path`
  }
}
