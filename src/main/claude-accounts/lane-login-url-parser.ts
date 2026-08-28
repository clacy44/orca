/**
 * Pure parsing helpers for the lane-login authorization stream (S9 §A3, §2b, §4).
 *
 * These MUST be fed from the live, chunk-driven stdout stream of the `claude` login
 * child (see lane-login-session.ts / claude-cli-child-process.ts) and never from an
 * accumulated, tail-truncated buffer such as service.ts's `runClaudeCommand` output —
 * a URL beyond the tail-truncation window would silently disappear, and the
 * paste-code prompt has no trailing newline so a line-buffered reader would hang.
 * The `create*Accumulator`/`create*Watcher` factories below own the chunk-boundary
 * contract (§2b: "a parse failure surfaces as a named lane state, never a hang") —
 * callers must not re-buffer chunks themselves before feeding them in.
 */
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

/** The exact prompt the Claude CLI prints once it is ready for a pasted code.
 * Deliberately has NO trailing newline — callers must test on raw chunks, never
 * on completed lines, or this prompt is never observed. */
const PASTE_CODE_PROMPT = 'Paste code here if prompted > '

/** Host+scheme a relayable authorization URL's own origin must equal (§2b, §4
 * R-32b: "whoever chooses which URL a person authenticates against chooses whose
 * lane receives the resulting grant"). Checking only `redirect_uri` and not this
 * origin lets an attacker-hosted page carry a well-formed redirect_uri through. */
const REQUIRED_AUTHORIZE_HOST = 'platform.claude.com'

/** Host a relayable authorization URL's `redirect_uri` query param must equal.
 * Anything else (e.g. a `localhost:<ephemeral>` loopback variant the CLI also prints)
 * must never be relayed to a client: a code delivered to an unauthenticated loopback
 * port on the person's own desktop is a plaintext credential leak. */
const REQUIRED_REDIRECT_HOST = 'platform.claude.com'

/** Matches a complete OSC-8 hyperlink — open sequence (carrying the target URL),
 * visible label, and close sequence — terminated by ST (`ESC \`) or BEL (`\x07`).
 * The label is discarded on strip: terminals commonly render the target URL as
 * its own visible label, so keeping the label would leave the same URL appearing
 * twice in the stripped text with no separator between the two copies (the prior
 * greedy-`\S*` shape additionally swallowed the terminator and close into the
 * capture, leaving raw escape bytes behind — both defects are fixed by capturing
 * only the target and dropping everything through the matching close). */
// eslint-disable-next-line no-control-regex -- OSC-8 hyperlink escapes ARE control bytes; matching them is the point.
const OSC8_LINK = /\x1b\]8;;([^\x1b\x07]*?)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;;(?:\x1b\\|\x07)/g

/** Matches any other ANSI escape (SGR colour codes, cursor show/hide, etc.) so
 * prompt/URL detection can tolerate the wrapping §2b records as unconditional
 * (`NO_COLOR=1 TERM=dumb` does not disable it). */
// eslint-disable-next-line no-control-regex -- see above.
const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|[()][A-Za-z0-9]|[a-zA-Z])/g

/** A bare http(s) URL, greedy up to whitespace or a control character. */
// eslint-disable-next-line no-control-regex -- terminates the match at the control bytes that follow a URL.
const URL_PATTERN = /https?:\/\/[^\s\x00-\x1f]+/g

/** Bound on the tail accumulated by `createAuthorizeUrlAccumulator`: comfortably
 * larger than the ~900-char printed URL (§2b) so a chunk boundary inside it never
 * loses the prefix, but capped so a runaway stream cannot grow it unbounded. */
const MAX_URL_ACCUMULATOR_CHARS = 8000

/** Bound on the tail kept by `createPasteCodePromptWatcher` — just long enough to
 * hold the prompt plus a run of trailing ANSI escapes. */
const MAX_PROMPT_TAIL_CHARS = PASTE_CODE_PROMPT.length + 64

const LOGIN_URL_UNPARSED_SENTENCE =
  'The authorization URL printed by the login process could not be safely relayed — ' +
  'it must be the https://platform.claude.com address the CLI prints, with a ' +
  'https://platform.claude.com redirect_uri, not a substitute. Cancel this login and try again.'

function loginUrlUnparsedRefusal(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal('accounts.lane.login_url_unparsed', LOGIN_URL_UNPARSED_SENTENCE)
}

/**
 * Strips OSC-8 hyperlink wrapping from a chunk of terminal output, replacing each
 * complete hyperlink (open, label, close) with just its target URL as plain text
 * so URL_PATTERN can find it — no escape bytes left behind, and no duplicate copy
 * of the URL from a label that echoes it (see OSC8_LINK).
 */
export function stripOsc8(text: string): string {
  return text.replace(OSC8_LINK, (_match, url: string) => url)
}

/**
 * Strips OSC-8 wrapping and every other ANSI escape (colour, cursor) from `text`.
 * Used wherever a match must not be confused by the wrapping §2b says is
 * unconditional, rather than relying on URL_PATTERN's control-byte cutoff by luck.
 */
function stripAllEscapes(text: string): string {
  return stripOsc8(text).replace(ANSI_ESCAPE, '')
}

/**
 * Returns the first http(s) URL found in `text` after OSC-8 stripping, or null.
 * This is a raw, unvalidated extraction — NOT a security decision. Use
 * `firstRelayableAuthorizeUrl` (single chunk) or `createAuthorizeUrlAccumulator`
 * (chunk-boundary-safe) to select the URL that is actually safe to relay.
 */
export function firstAuthorizeUrl(text: string): string | null {
  const stripped = stripAllEscapes(text)
  const match = URL_PATTERN.exec(stripped)
  URL_PATTERN.lastIndex = 0
  return match ? match[0] : null
}

/**
 * True when `url` is a printed (not loopback-callback) Claude authorization URL
 * safe to relay to a client: its own origin must be exactly
 * `https://platform.claude.com` (§4 R-32b — the origin itself, not only
 * `redirect_uri`, is what an attacker-hosted phishing page would substitute),
 * and its `redirect_uri` query parameter must itself be an
 * `https://platform.claude.com` URL, not a `localhost:<ephemeral>` loopback.
 */
export function isRelayableAuthorizeUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== REQUIRED_AUTHORIZE_HOST) {
    return false
  }
  const redirectUri = parsed.searchParams.get('redirect_uri')
  if (!redirectUri) {
    return false
  }
  let redirect: URL
  try {
    redirect = new URL(redirectUri)
  } catch {
    return false
  }
  return redirect.protocol === 'https:' && redirect.hostname === REQUIRED_REDIRECT_HOST
}

/**
 * Throws `ClaudeLaneRefusal('accounts.lane.login_url_unparsed', …)` unless `url`
 * is relayable per `isRelayableAuthorizeUrl` — a refusal, not a hang (§2b).
 */
export function assertRelayableAuthorizeUrl(url: string): void {
  if (!isRelayableAuthorizeUrl(url)) {
    throw loginUrlUnparsedRefusal()
  }
}

/**
 * Selection and validation as one operation (§5 "Printed URL only"): scans every
 * http(s) candidate in `text`, in order, and returns the first one that is
 * actually relayable — never the first URL of any kind, and never "last URL
 * wins". A stream that prints a loopback variant before the hosted one (or an
 * unrelated banner URL before either) still relays the hosted URL, by
 * construction, because a non-qualifying candidate is skipped rather than
 * accepted-then-asserted. Throws `login_url_unparsed` only when no candidate in
 * `text` qualifies.
 */
export function firstRelayableAuthorizeUrl(text: string): string {
  const stripped = stripAllEscapes(text)
  const candidates = stripped.match(URL_PATTERN) ?? []
  for (const candidate of candidates) {
    if (isRelayableAuthorizeUrl(candidate)) {
      return candidate
    }
  }
  throw loginUrlUnparsedRefusal()
}

/**
 * Chunk-boundary-safe accumulator for `firstRelayableAuthorizeUrl`. The ~900-char
 * printed URL (§2b) can straddle a stdout chunk boundary; feeding chunks straight
 * to `firstRelayableAuthorizeUrl` one at a time would truncate it mid-string and
 * refuse a legitimate login. `feed` accumulates a bounded tail and returns a URL
 * only once a candidate match is confirmed complete — terminated by a real
 * boundary byte in the buffer, not merely by having reached the end of whatever
 * has arrived so far, which could still be a truncated prefix.
 */
export function createAuthorizeUrlAccumulator(): { feed(chunk: string): string | null } {
  let buffer = ''
  return {
    feed(chunk: string): string | null {
      buffer += chunk
      if (buffer.length > MAX_URL_ACCUMULATOR_CHARS) {
        buffer = buffer.slice(-MAX_URL_ACCUMULATOR_CHARS)
      }
      const stripped = stripAllEscapes(buffer)
      URL_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      // eslint-disable-next-line no-cond-assign -- scanning every candidate, first relayable wins.
      while ((match = URL_PATTERN.exec(stripped))) {
        const matchEndsAtBufferTail = match.index + match[0].length === stripped.length
        // A match flush against the end of what we've accumulated so far might
        // still be a truncated prefix of a longer URL — wait for more input
        // unless the buffer is already at its cap, in which case this is the
        // most we will ever see of it.
        if (matchEndsAtBufferTail && buffer.length < MAX_URL_ACCUMULATOR_CHARS) {
          continue
        }
        if (isRelayableAuthorizeUrl(match[0])) {
          URL_PATTERN.lastIndex = 0
          return match[0]
        }
      }
      URL_PATTERN.lastIndex = 0
      return null
    }
  }
}

/**
 * True when `tail` ends with the Claude CLI's paste-code prompt, tolerant of the
 * trailing ANSI escapes (colour reset, cursor show) §2b records as unconditional.
 * Callers must pass the raw, not-yet-newline-terminated tail of the live stream —
 * this prompt never gets a trailing newline, so a reader that waits for one hangs.
 */
export function isPasteCodePrompt(tail: string): boolean {
  return stripAllEscapes(tail).endsWith(PASTE_CODE_PROMPT)
}

/**
 * Chunk-boundary-safe watcher for `isPasteCodePrompt`. The prompt can arrive
 * split across two stdout chunks (no trailing newline to force a flush), so a
 * bare per-chunk `endsWith` check misses it; `feed` keeps a bounded rolling tail
 * across calls and tests the joined text.
 */
export function createPasteCodePromptWatcher(): { feed(chunk: string): boolean } {
  let tail = ''
  return {
    feed(chunk: string): boolean {
      tail = (tail + chunk).slice(-MAX_PROMPT_TAIL_CHARS)
      return isPasteCodePrompt(tail)
    }
  }
}
