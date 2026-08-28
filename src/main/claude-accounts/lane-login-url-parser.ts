/**
 * Pure parsing helpers for the lane-login authorization stream (S9 §A3).
 *
 * These MUST be fed from the live, chunk-driven stdout stream of the `claude` login
 * child (see lane-login-session.ts / claude-cli-child-process.ts) and never from an
 * accumulated, tail-truncated buffer such as service.ts's `runClaudeCommand` output —
 * a URL beyond the tail-truncation window would silently disappear, and the
 * paste-code prompt has no trailing newline so a line-buffered reader would hang
 * waiting for one that never comes.
 */

/** The exact prompt the Claude CLI prints once it is ready for a pasted code.
 * Deliberately has NO trailing newline — callers must test on raw chunks, never
 * on completed lines, or this prompt is never observed. */
const PASTE_CODE_PROMPT = 'Paste code here if prompted > '

/** Host that a relayable authorization URL's `redirect_uri` query param must equal.
 * Anything else (e.g. a `localhost:<ephemeral>` loopback variant the CLI also prints)
 * must never be relayed to a client: a code delivered to an unauthenticated loopback
 * port on the person's own desktop is a plaintext credential leak. */
const REQUIRED_REDIRECT_HOST = 'platform.claude.com'

/** Matches an OSC-8 hyperlink escape sequence wrapping a URL:
 * ESC ] 8 ; ; <url> ESC \  ... text ...  ESC ] 8 ; ; ESC \
 * We only need to strip the opening sequence's URL-bearing form and the closing
 * (empty-url) form, leaving the human-visible text and bare URLs intact. */
// eslint-disable-next-line no-control-regex -- OSC-8 hyperlink escapes ARE control bytes; matching them is the point.
const OSC8_OPEN = /\x1b\]8;;(\S*)\x1b\\/g
// eslint-disable-next-line no-control-regex -- see above.
const OSC8_CLOSE = /\x1b\]8;;\x1b\\/g

/** A bare http(s) URL, greedy up to whitespace or a control character. */
// eslint-disable-next-line no-control-regex -- terminates the match at the control bytes that follow a URL.
const URL_PATTERN = /https?:\/\/[^\s\x00-\x1f]+/g

/**
 * Strips OSC-8 hyperlink wrapping from a chunk of terminal output, leaving the
 * URL that was inside the escape sequence (if any) as plain text so URL_PATTERN
 * can find it, plus whatever visible text followed.
 */
export function stripOsc8(text: string): string {
  return text.replace(OSC8_OPEN, (_match, url: string) => url).replace(OSC8_CLOSE, '')
}

/**
 * Returns the first http(s) URL found in `text` after OSC-8 stripping, or null.
 * Callers MUST feed this incrementally from the live stream and stop at the first
 * match — "last URL wins" is wrong: the CLI can print more than one URL variant
 * (a hosted `platform.claude.com` one and a `localhost` loopback one), and only
 * the first is meaningful here because `firstAuthorizeUrl` is expected to be
 * called against each new chunk until it returns non-null, then never again.
 */
export function firstAuthorizeUrl(text: string): string | null {
  const stripped = stripOsc8(text)
  const match = URL_PATTERN.exec(stripped)
  URL_PATTERN.lastIndex = 0
  return match ? match[0] : null
}

/** Refusal thrown by assertRelayableAuthorizeUrl when a URL cannot be relayed safely. */
export class UnrelayableAuthorizeUrlError extends Error {
  readonly code = 'accounts.lane.login_url_unparsed' as const
  constructor(reason: string) {
    super(reason)
    this.name = 'UnrelayableAuthorizeUrlError'
  }
}

/**
 * Validates that `url` is a printed (not loopback-callback) Claude authorization
 * URL safe to relay to a client: it must parse, and its `redirect_uri` query
 * parameter's host must be exactly `platform.claude.com`. Throws
 * UnrelayableAuthorizeUrlError otherwise — this is a refusal, not a hang.
 */
export function assertRelayableAuthorizeUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnrelayableAuthorizeUrlError('Authorization URL did not parse.')
  }
  const redirectUri = parsed.searchParams.get('redirect_uri')
  if (!redirectUri) {
    throw new UnrelayableAuthorizeUrlError('Authorization URL carried no redirect_uri.')
  }
  let redirectHost: string
  try {
    redirectHost = new URL(redirectUri).hostname
  } catch {
    throw new UnrelayableAuthorizeUrlError('Authorization URL redirect_uri did not parse.')
  }
  if (redirectHost !== REQUIRED_REDIRECT_HOST) {
    throw new UnrelayableAuthorizeUrlError(
      `Authorization URL redirect_uri host was "${redirectHost}", not "${REQUIRED_REDIRECT_HOST}".`
    )
  }
}

/**
 * True when `tail` ends with the Claude CLI's paste-code prompt. Callers must pass
 * the raw, not-yet-newline-terminated tail of the live stream — this prompt never
 * gets a trailing newline, so a reader that waits for one hangs forever.
 */
export function isPasteCodePrompt(tail: string): boolean {
  return tail.endsWith(PASTE_CODE_PROMPT)
}
