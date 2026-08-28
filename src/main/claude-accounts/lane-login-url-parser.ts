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
 *
 * Which URL is safe to relay at all is NOT decided here — that allow-list is shared
 * with any client that must agree with the host (`../../shared/claude-authorize-url-policy`).
 * This module owns only: extracting URL text out of a raw terminal stream, and deciding
 * WHEN a candidate is complete enough to judge.
 */
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  describeAuthorizeUrlRejection,
  isRelayableAuthorizeUrl as isRelayableAuthorizeUrlPolicy
} from '../../shared/claude-authorize-url-policy'

/** The exact prompt the Claude CLI prints once it is ready for a pasted code.
 * Deliberately has NO trailing newline — callers must test on raw chunks, never
 * on completed lines, or this prompt is never observed.
 *
 * Verified against the installed `claude` binary, version 2.1.250: a live, throwaway
 * `claude auth login --claudeai` run (killed before completion, never submitted) printed
 * this prompt verbatim, with no trailing newline, immediately after the authorize URL.
 * Re-verify whenever the pinned CLI version bumps (see
 * lane-login-cli-version-gate.ts's LAST_VERIFIED_CLI_VERSION). */
const PASTE_CODE_PROMPT = 'Paste code here if prompted > '

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

function loginUrlUnparsedRefusal(candidate: string | null): ClaudeLaneRefusal {
  const detail = candidate
    ? `it was not safe to relay — ${describeAuthorizeUrlRejection(candidate)}, and that is not an address Orca will send you to`
    : 'the login process never printed one'
  return new ClaudeLaneRefusal(
    'accounts.lane.login_url_unparsed',
    `Orca could not safely relay the authorization URL the login process printed: ${detail}. ` +
      'Cancel this login and try again.'
  )
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
 * True when `url` is safe to relay per the shared allow-list
 * (`../../shared/claude-authorize-url-policy`) — re-exported here so existing callers of this
 * module do not need a second import for the one check that matters most.
 */
export function isRelayableAuthorizeUrl(url: string): boolean {
  return isRelayableAuthorizeUrlPolicy(url)
}

/**
 * Throws `ClaudeLaneRefusal('accounts.lane.login_url_unparsed', …)` unless `url`
 * is relayable per `isRelayableAuthorizeUrl` — a refusal, not a hang (§2b).
 */
export function assertRelayableAuthorizeUrl(url: string): void {
  if (!isRelayableAuthorizeUrl(url)) {
    throw loginUrlUnparsedRefusal(url)
  }
}

/**
 * Finds the FIRST http(s) URL candidate in `strippedText` and decides on it immediately — never
 * "keep scanning past a bad one hoping a later one is better" (§2b prompt refusal: a decoy or
 * compromised first candidate must refuse promptly, not stall the login waiting for a legitimate
 * one that may never come). `atStreamEnd` distinguishes the two ways a candidate counts as
 * complete (§2b): terminated by a real boundary byte already in the text (whitespace/control
 * character — true regardless of `atStreamEnd`), or, when `atStreamEnd` is true, simply having
 * reached the end of everything the stream will ever produce (the child exited, or a one-shot
 * caller handed over its whole text at once). A match run to the text's end while `atStreamEnd`
 * is false is treated as "wait for more" — it could still be a truncated prefix.
 *
 * Returns the relayable URL, or `null` when nothing decidable is present yet (only possible with
 * `atStreamEnd: false`). Throws `login_url_unparsed` when the first candidate found is complete
 * and not relayable, OR (only at `atStreamEnd`) when no candidate was ever found at all.
 */
function decideFirstUrlCandidate(strippedText: string, atStreamEnd: boolean): string | null {
  URL_PATTERN.lastIndex = 0
  const match = URL_PATTERN.exec(strippedText)
  URL_PATTERN.lastIndex = 0
  if (!match) {
    if (atStreamEnd) {
      throw loginUrlUnparsedRefusal(null)
    }
    return null
  }
  const matchEndsAtTextEnd = match.index + match[0].length === strippedText.length
  if (matchEndsAtTextEnd && !atStreamEnd) {
    // Might still be a truncated prefix of a longer URL — wait for more.
    return null
  }
  const candidate = match[0]
  if (isRelayableAuthorizeUrl(candidate)) {
    return candidate
  }
  throw loginUrlUnparsedRefusal(candidate)
}

/**
 * Selection and validation of the FIRST http(s) URL candidate in `text` as one operation: decides
 * immediately rather than scanning past a non-qualifying candidate for a later, better one (see
 * `decideFirstUrlCandidate`). `text` is treated as a complete, final stream (`atStreamEnd: true`)
 * — the natural shape for a one-shot caller, and what `createAuthorizeUrlAccumulator.finish()`
 * uses at end-of-stream.
 */
export function firstRelayableAuthorizeUrl(text: string): string {
  const stripped = stripAllEscapes(text)
  // `decideFirstUrlCandidate` with `atStreamEnd: true` always either returns a string or throws —
  // it never returns null in that mode — but that isn't expressible in its own return type since
  // the mid-stream (`atStreamEnd: false`) mode legitimately can.
  return decideFirstUrlCandidate(stripped, true) as string
}

/**
 * Chunk-boundary-safe accumulator for `firstRelayableAuthorizeUrl`. The ~900-char
 * printed URL (§2b) can straddle a stdout chunk boundary; feeding chunks straight
 * to `firstRelayableAuthorizeUrl` one at a time would truncate it mid-string and
 * refuse a legitimate login. `feed` accumulates a bounded tail and decides on the
 * FIRST complete URL candidate the moment it is confirmed complete — terminated by
 * a real boundary byte (whitespace/control character) already in the buffer, NEVER
 * by merely having reached the end of whatever has arrived so far, which could
 * still be a truncated prefix. Deciding on the first candidate (not scanning past
 * it for a later one) is itself the §2b "prompt refusal" contract: a login child
 * that prints one non-relayable URL and nothing else must refuse promptly, not
 * wait indefinitely for a second URL that will never arrive. Reaching the cap
 * without ever observing a terminated match discards the buffer and refuses
 * `login_url_unparsed` rather than guessing. `finish()` is the only path that
 * treats a still-unterminated match as final — call it once the child's stdout
 * stream itself has ended, so a URL that is the very last thing printed (with
 * no trailing byte to terminate it) still resolves to a URL or a refusal,
 * never silence.
 */
export function createAuthorizeUrlAccumulator(): {
  feed(chunk: string): string | null
  finish(): string
} {
  let buffer = ''
  return {
    feed(chunk: string): string | null {
      buffer += chunk
      if (buffer.length > MAX_URL_ACCUMULATOR_CHARS) {
        // Never emit a prefix we cannot see complete: give up on whatever was
        // accumulating rather than risk relaying a truncated authorization URL.
        buffer = ''
        throw loginUrlUnparsedRefusal(null)
      }
      const stripped = stripAllEscapes(buffer)
      const decided = decideFirstUrlCandidate(stripped, false)
      if (decided) {
        buffer = ''
      }
      return decided
    },
    finish(): string {
      // End of stream is itself a boundary: a match ending at the buffer tail
      // is no longer "possibly truncated" — nothing more will ever arrive.
      const relayed = firstRelayableAuthorizeUrl(buffer)
      buffer = ''
      return relayed
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
