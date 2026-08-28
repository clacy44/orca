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
 * only the target and dropping everything through the matching close). The
 * captured target requires at least one char (`+?`, not `*?`): an OSC-8 open with
 * an EMPTY target is per-spec indistinguishable from a bare close, so treating it
 * as an open too would let a real CLOSE sequence stand in for an open, capture
 * everything up to the NEXT close (including a real URL sitting between them) as
 * a throwaway "label", and erase it on strip. A bare close with nothing open
 * simply fails to match here and its raw bytes pass through unstripped — control
 * bytes URL_PATTERN already stops at, so they cannot hide a URL either. */
// eslint-disable-next-line no-control-regex -- OSC-8 hyperlink escapes ARE control bytes; matching them is the point.
const OSC8_LINK = /\x1b\]8;;([^\x1b\x07]+?)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;;(?:\x1b\\|\x07)/g

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

type LoginUrlUnparsedCause =
  | { kind: 'rejected'; candidate: string }
  | { kind: 'none' }
  | { kind: 'cap' }

function loginUrlUnparsedRefusal(cause: LoginUrlUnparsedCause): ClaudeLaneRefusal {
  // `describeAuthorizeUrlRejection` names the check that actually failed (scheme, host, port,
  // path, or the redirect_uri) — never a fixed "its host was…" clause, which would blame an
  // allow-listed host for a rejection that came from somewhere else. The three causes are kept
  // apart so the sentence never tells an operator the opposite of what happened: "never printed
  // one" when the child printed a rejected URL, or when it printed more than the bound holds.
  const detail =
    cause.kind === 'rejected'
      ? `it was not safe to relay — ${describeAuthorizeUrlRejection(cause.candidate)}`
      : cause.kind === 'cap'
        ? 'the login process printed more text than Orca will hold without a complete authorization URL in it'
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
    throw loginUrlUnparsedRefusal({ kind: 'rejected', candidate: url })
  }
}

type RelayableUrlScan =
  | { relayable: string; firstRejected: null }
  | { relayable: null; firstRejected: string | null }

/**
 * Scans every http(s) URL candidate in `strippedText` in print order and selects the FIRST
 * RELAYABLE one — the §2 "printed URL only" rule: a login run can legitimately print a
 * non-relayable URL ahead of the hosted one (the `http://localhost:<port>/callback` browser-opener
 * variant, a docs or banner link), and skipping it is what keeps such a run from being refused.
 * A candidate is complete when a boundary byte (whitespace / control character) already follows
 * it in the text, or, when `atStreamEnd` is true, when it simply runs to the end of everything
 * the stream will ever produce (the child exited, or the paste prompt — the CLI's own "I have
 * finished printing the URL" signal — arrived, or a one-shot caller handed over its whole text).
 * A candidate that runs to the text's end while `atStreamEnd` is false could still be a truncated
 * prefix, so scanning stops there and the caller waits for more.
 *
 * Never throws: when nothing relayable is present it reports the first rejected candidate (if
 * any) so the caller can decide — wait for more (mid-stream) or refuse (at stream end / cap) —
 * and word the refusal after what was actually seen.
 */
function scanForRelayableUrl(strippedText: string, atStreamEnd: boolean): RelayableUrlScan {
  URL_PATTERN.lastIndex = 0
  let firstRejected: string | null = null
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(strippedText)) !== null) {
    const candidate = match[0]
    const matchEndsAtTextEnd = match.index + candidate.length === strippedText.length
    if (matchEndsAtTextEnd && !atStreamEnd) {
      // Might still be a truncated prefix of a longer URL — wait for more.
      break
    }
    if (isRelayableAuthorizeUrl(candidate)) {
      URL_PATTERN.lastIndex = 0
      // Relay the WHATWG-normalized `.href`, not the raw matched text: `isRelayableAuthorizeUrl`
      // already parsed `candidate` successfully (so this reparse cannot throw), and normalizing is
      // what folds an oddity like `https:/\host/...` to the canonical `https://host/...` a
      // downstream parser (QR encoder, mobile `Linking.openURL`) may read differently than WHATWG
      // does, and percent-encodes a raw bidi-override or other non-ASCII byte sitting in the query
      // string rather than relaying it as literal text that could visually mislead a person reading
      // the URL before they authenticate against it.
      return { relayable: new URL(candidate).href, firstRejected: null }
    }
    firstRejected ??= candidate
  }
  URL_PATTERN.lastIndex = 0
  return { relayable: null, firstRejected }
}

function refusalForEndOfStream(scan: RelayableUrlScan): ClaudeLaneRefusal {
  return loginUrlUnparsedRefusal(
    scan.firstRejected ? { kind: 'rejected', candidate: scan.firstRejected } : { kind: 'none' }
  )
}

/**
 * Selection and validation of the first RELAYABLE http(s) URL in `text` as one operation (see
 * `scanForRelayableUrl`). `text` is treated as a complete, final stream (`atStreamEnd: true`) —
 * the natural shape for a one-shot caller, and what `createAuthorizeUrlAccumulator.finish()` uses
 * at end-of-stream — so the outcome is always a URL or a `login_url_unparsed` refusal, never
 * silence (§2b).
 */
export function firstRelayableAuthorizeUrl(text: string): string {
  const scan = scanForRelayableUrl(stripAllEscapes(text), true)
  if (scan.relayable) {
    return scan.relayable
  }
  throw refusalForEndOfStream(scan)
}

/**
 * Chunk-boundary-safe accumulator for `firstRelayableAuthorizeUrl`. The ~900-char
 * printed URL (§2b) can straddle a stdout chunk boundary; feeding chunks straight
 * to `firstRelayableAuthorizeUrl` one at a time would truncate it mid-string and
 * refuse a legitimate login. `feed` accumulates a bounded tail and relays the
 * first RELAYABLE complete candidate the moment one is confirmed complete —
 * terminated by a real boundary byte (whitespace/control character) already in
 * the buffer, NEVER by merely having reached the end of whatever has arrived so
 * far, which could still be a truncated prefix. A complete candidate that is NOT
 * relayable is skipped, not refused (§2 "printed URL only": the loopback variant
 * or a banner link may precede the hosted URL); the refusal for a stream that
 * never carries a relayable one is raised where the stream provably ends —
 * `finish()`, which the session calls on the paste-prompt edge and on child exit
 * — or at the cap below, so a login is never parked on a decoy for longer than
 * the child keeps printing, and never past its own timeout. Reaching the cap
 * without a relayable candidate discards the buffer and refuses
 * `login_url_unparsed`, worded after what was seen (a rejected candidate, or
 * simply too much text), rather than guessing.
 */
export function createAuthorizeUrlAccumulator(): {
  feed(chunk: string): string | null
  finish(): string
} {
  let buffer = ''
  return {
    feed(chunk: string): string | null {
      buffer += chunk
      // Decide BEFORE checking the cap: a chunk that pushes the buffer over
      // MAX_URL_ACCUMULATOR_CHARS can still carry a complete, decidable candidate (a chatty CLI's
      // noise plus a fully-terminated URL) — discarding on length alone first would misreport that
      // as "the login process never printed one" when it plainly did. The cap still protects
      // against unbounded growth: it only fires below when no decision was reachable.
      const scan = scanForRelayableUrl(stripAllEscapes(buffer), false)
      if (scan.relayable) {
        buffer = ''
        return scan.relayable
      }
      if (buffer.length > MAX_URL_ACCUMULATOR_CHARS) {
        // Never emit a prefix we cannot see complete: give up on whatever was
        // accumulating rather than risk relaying a truncated authorization URL.
        buffer = ''
        throw loginUrlUnparsedRefusal(
          scan.firstRejected ? { kind: 'rejected', candidate: scan.firstRejected } : { kind: 'cap' }
        )
      }
      return null
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
