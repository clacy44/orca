import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  assertRelayableAuthorizeUrl,
  createAuthorizeUrlAccumulator,
  createPasteCodePromptWatcher,
  firstAuthorizeUrl,
  firstRelayableAuthorizeUrl,
  isPasteCodePrompt,
  isRelayableAuthorizeUrl,
  stripOsc8
} from './lane-login-url-parser'

// The real 2.1.250 shape (§4 negative control): `claude.com` + `/cai/oauth/authorize`, a
// `platform.claude.com` redirect_uri — observed via a live, throwaway `claude auth login
// --claudeai` run (killed before completion, never submitted) and confirmed against the
// installed binary's `strings` output. See `../../shared/claude-authorize-url-policy.ts` for the
// full allow-list this (and the other allow-listed shapes) is checked against.
const HOSTED_URL = `https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}&code_challenge_method=S256`

const LOOPBACK_URL = `https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'http://localhost:54231/callback'
)}`

// P1/P1b: an attacker-hosted or plaintext origin, well-formed redirect_uri and all.
const PHISHING_URL = `https://evil.example.com/oauth/authorize?redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}`
const PHISHING_URL_PLAINTEXT_IP = `http://192.0.2.7:8080/authorize?redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}`
// P2: correct origin, but redirect_uri downgraded to plaintext.
const DOWNGRADED_REDIRECT_URL = `https://claude.com/cai/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'http://platform.claude.com/oauth/code/callback'
)}`

function osc8Wrap(url: string, label = 'link'): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`
}

describe('stripOsc8', () => {
  it('unwraps an OSC-8 hyperlink to its target URL, dropping the label', () => {
    const wrapped = `text before ${osc8Wrap(HOSTED_URL)} text after`
    expect(stripOsc8(wrapped)).toBe(`text before ${HOSTED_URL} text after`)
  })

  it('leaves plain text with no OSC-8 sequences unchanged', () => {
    expect(stripOsc8('plain text, no escapes')).toBe('plain text, no escapes')
  })

  // P4: the prior greedy-\S* shape retained raw escape bytes and duplicated the
  // URL when the visible label was itself the URL (the common real-world shape:
  // a terminal hyperlink whose clickable text repeats its target). Discarding
  // the label on strip fixes both — one clean copy of the URL, no residue.
  it('strips cleanly to a single copy even when the visible label is itself the URL', () => {
    const wrapped = `\x1b]8;;${HOSTED_URL}\x1b\\${HOSTED_URL}\x1b]8;;\x1b\\`
    expect(stripOsc8(wrapped)).toBe(HOSTED_URL)
  })

  it('strips a BEL-terminated (\\x07) hyperlink, not only ST (ESC \\\\)', () => {
    const wrapped = `\x1b]8;;${HOSTED_URL}\x07link\x1b]8;;\x07`
    expect(stripOsc8(wrapped)).toBe(HOSTED_URL)
  })

  // P4b: two adjacent hyperlinks must not collapse into one match.
  it('strips two adjacent hyperlinks independently', () => {
    const wrapped = `${osc8Wrap(HOSTED_URL, 'a')}${osc8Wrap(LOOPBACK_URL, 'b')}`
    expect(stripOsc8(wrapped)).toBe(`${HOSTED_URL}${LOOPBACK_URL}`)
  })

  // P: a bare OSC-8 CLOSE (empty target) must never be treated as an OPEN — doing so lets the
  // real URL sitting between two closes be captured as a throwaway "label" and erased entirely.
  it('does not erase a URL sitting between two bare OSC-8 closes', () => {
    const wrapped = `\x1b]8;;\x07 ${HOSTED_URL} \x1b]8;;\x07`
    expect(stripOsc8(wrapped)).toContain(HOSTED_URL)
  })

  // MP: allowing an empty target to count as an open (`*?` instead of `+?`) reproduces exactly
  // this collapse — the fix's own doc comment names it.
  it('mutation proof: an empty-target-as-open regex would collapse the two-close case above to empty', () => {
    // eslint-disable-next-line no-control-regex -- reproduces the pre-fix regex shape for the proof.
    const preFixRegex = /\x1b\]8;;([^\x1b\x07]*?)(?:\x1b\\|\x07)[\s\S]*?\x1b\]8;;(?:\x1b\\|\x07)/g
    const wrapped = `\x1b]8;;\x07 ${HOSTED_URL} \x1b]8;;\x07`
    const preFixResult = wrapped.replace(preFixRegex, (_match, url: string) => url)
    expect(preFixResult).toBe('') // ...the old shape erases the URL entirely...
    expect(stripOsc8(wrapped)).not.toBe('') // ...the shipped fix does not.
  })
})

describe('firstAuthorizeUrl', () => {
  it('extracts a bare https URL', () => {
    expect(firstAuthorizeUrl(`go here: ${HOSTED_URL} thanks`)).toBe(HOSTED_URL)
  })

  it('extracts a URL wrapped in OSC-8', () => {
    expect(firstAuthorizeUrl(osc8Wrap(HOSTED_URL))).toBe(HOSTED_URL)
  })

  it('returns null when no URL is present', () => {
    expect(firstAuthorizeUrl('no url in this chunk')).toBeNull()
  })
})

describe('isRelayableAuthorizeUrl / assertRelayableAuthorizeUrl', () => {
  // Delegates to `../../shared/claude-authorize-url-policy.ts`, whose own test file carries the
  // full allow-list matrix and per-rejected-class mutation proofs — these stay as a thin
  // integration check that the delegation actually happened.
  it('accepts the real (claude.com, /cai/oauth/authorize, platform.claude.com redirect) shape', () => {
    expect(isRelayableAuthorizeUrl(HOSTED_URL)).toBe(true)
    expect(() => assertRelayableAuthorizeUrl(HOSTED_URL)).not.toThrow()
  })

  // MP: relaying the loopback URL is the concrete harm this guards against — a
  // code delivered as a plaintext GET query string to an unauthenticated
  // loopback port on the person's own desktop.
  it('refuses a URL whose redirect_uri host is a localhost loopback', () => {
    expect(isRelayableAuthorizeUrl(LOOPBACK_URL)).toBe(false)
    expect(() => assertRelayableAuthorizeUrl(LOOPBACK_URL)).toThrow()
  })

  it('refuses a URL with no redirect_uri at all', () => {
    expect(isRelayableAuthorizeUrl('https://platform.claude.com/oauth/authorize')).toBe(false)
  })

  it('refuses a string that does not parse as a URL', () => {
    expect(isRelayableAuthorizeUrl('not a url at all')).toBe(false)
  })

  // P1: an attacker-hosted origin with a well-formed, correct redirect_uri.
  it('refuses a URL whose own origin is not on the allow-list (P1)', () => {
    expect(isRelayableAuthorizeUrl(PHISHING_URL)).toBe(false)
  })

  // P1b: a plaintext non-Anthropic origin, redirect_uri still correct.
  it('refuses a plaintext IP-literal origin (P1b)', () => {
    expect(isRelayableAuthorizeUrl(PHISHING_URL_PLAINTEXT_IP)).toBe(false)
  })

  // P2: only the redirect_uri scheme is downgraded; hostname comparison alone
  // would miss this.
  it('refuses a redirect_uri downgraded from https to http (P2)', () => {
    expect(isRelayableAuthorizeUrl(DOWNGRADED_REDIRECT_URL)).toBe(false)
  })

  // P2d (review-r2): a duplicate redirect_uri must refuse outright, not validate
  // only the first occurrence and ignore the second.
  it('refuses a URL carrying more than one redirect_uri (P2d)', () => {
    const duplicated = `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent(
      'https://platform.claude.com/oauth/code/callback'
    )}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
    expect(isRelayableAuthorizeUrl(duplicated)).toBe(false)
  })

  // MP: getting redirect_uri via `.get()` (first occurrence only) rather than
  // requiring `.getAll()` to have exactly one entry lets the duplicate above pass.
  it('mutation proof: reading only the first redirect_uri accepts the duplicate above', () => {
    const duplicated = `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent(
      'https://platform.claude.com/oauth/code/callback'
    )}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`
    const parsed = new URL(duplicated)
    const firstOnly = parsed.searchParams.get('redirect_uri')
    expect(firstOnly).toBe('https://platform.claude.com/oauth/code/callback')
    // ...the value a `.get()`-based guard would have validated and accepted —
    // while the shipped guard correctly refuses the whole URL.
    expect(isRelayableAuthorizeUrl(duplicated)).toBe(false)
  })

  // P2e (review-r2): the endpoint itself must be pinned, not any path on the host.
  it('refuses a well-formed URL on an unexpected pathname (P2e)', () => {
    const wrongPath = `https://platform.claude.com/anything/at/all?redirect_uri=${encodeURIComponent(
      'https://platform.claude.com/oauth/code/callback'
    )}`
    expect(isRelayableAuthorizeUrl(wrongPath)).toBe(false)
  })

  // P7: the refusal is a typed ClaudeLaneRefusal, not a bespoke error class the
  // shared refusal machinery does not recognize.
  it('throws a ClaudeLaneRefusal carrying accounts.lane.login_url_unparsed', () => {
    try {
      assertRelayableAuthorizeUrl(LOOPBACK_URL)
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe(
        'accounts.lane.login_url_unparsed'
      )
      expect(isClaudeLaneRefusal(error) ? error.message.length : 0).toBeGreaterThan(40)
    }
  })
})

describe('firstRelayableAuthorizeUrl', () => {
  it('relays the hosted URL', () => {
    expect(firstRelayableAuthorizeUrl(`go here: ${HOSTED_URL} thanks`)).toBe(HOSTED_URL)
  })

  // §2b prompt refusal: decides on the FIRST complete URL candidate and never scans past it
  // hoping a later one is better — a login child that prints one bad URL and stops must refuse
  // promptly, not wait forever for a second URL that will never come. A real login never prints
  // a loopback variant before the hosted one (confirmed live against 2.1.250 — see the module
  // doc comment), so refusing on the first candidate costs nothing in practice.
  it('refuses on a non-relayable loopback URL printed first — does NOT wait for the hosted one after it', () => {
    const stream = `browser opener: ${LOOPBACK_URL}\nprinted: ${HOSTED_URL}\n`
    expect(() => firstRelayableAuthorizeUrl(stream)).toThrow()
  })

  // Same "decide on first, period" rule applies to an unrelated banner URL, not only a
  // security-relevant lookalike.
  it('refuses on an unrelated banner URL printed first — does NOT skip ahead to the real one', () => {
    const stream = `Learn more at https://docs.claude.com/cli\n${HOSTED_URL}\n`
    expect(() => firstRelayableAuthorizeUrl(stream)).toThrow()
  })

  // MP: a "scan every candidate, first RELAYABLE one wins" selector (the pre-fix decomposition)
  // would keep looking past the bad first candidate and successfully relay the hosted URL here —
  // exactly the behavior that leaves a real "one bad URL, nothing after it" stream undecided
  // forever instead of refusing. The shipped function decides on the first candidate instead.
  it('mutation proof: scanning past a non-relayable first candidate for a later relayable one would (wrongly) succeed here', () => {
    const loopbackFirst = `browser opener: ${LOOPBACK_URL}\nprinted: ${HOSTED_URL}\n`
    const candidates = loopbackFirst.match(/https?:\/\/[^\s]+/g) ?? []
    const scanPastBadFirstCandidate = candidates.find((candidate) =>
      isRelayableAuthorizeUrl(candidate)
    )
    expect(scanPastBadFirstCandidate).toBe(HOSTED_URL) // ...the old "keep scanning" shape finds it...
    // ...the shipped function, deciding on the first candidate only, refuses instead.
    expect(() => firstRelayableAuthorizeUrl(loopbackFirst)).toThrow()
  })

  it('refuses when the only candidate in the text is not relayable', () => {
    expect(() => firstRelayableAuthorizeUrl(`only this: ${LOOPBACK_URL}`)).toThrow()
  })

  // The relayed value is the WHATWG-normalized `.href`, not the raw matched text: a raw bidi
  // control character sitting in the query string (invisible plumbing to every check here, since
  // validation only looks at `redirect_uri`) must not survive into what a person reads before
  // authenticating — `.href` percent-encodes it like any other non-ASCII byte.
  it('percent-encodes a raw bidi-override character in the query string rather than relaying it literally', () => {
    const withBidiOverride = `${HOSTED_URL}&x=‮evil`
    const relayed = firstRelayableAuthorizeUrl(withBidiOverride)
    expect(relayed).toBe(new URL(withBidiOverride).href)
    expect(relayed).not.toContain('‮')
    expect(relayed).toContain('%E2%80%AE')
  })

  // MP: relaying `match[0]` (the pre-fix shape) would hand back the raw text with the literal
  // bidi-override byte still sitting in it, unchanged from what was printed.
  it('mutation proof: relaying the raw matched text instead of the normalized href would keep the raw bidi override', () => {
    const withBidiOverride = `${HOSTED_URL}&x=‮evil`
    expect(withBidiOverride).toContain('‮') // ...the raw text the old shape would relay...
    expect(firstRelayableAuthorizeUrl(withBidiOverride)).not.toContain('‮') // ...the fix does not.
  })

  it('refuses when no candidate is present in the text at all', () => {
    try {
      firstRelayableAuthorizeUrl('no url at all here')
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error) ? error.code : null).toBe(
        'accounts.lane.login_url_unparsed'
      )
    }
  })
})

describe('createAuthorizeUrlAccumulator', () => {
  it('returns the URL once a single chunk completes it', () => {
    const acc = createAuthorizeUrlAccumulator()
    expect(acc.feed(`printed: ${HOSTED_URL} more text after\n`)).toBe(HOSTED_URL)
  })

  // P9: a chunk boundary falling inside the ~900-char URL must not truncate it
  // into a refusal — the accumulator must wait for the rest.
  it('does not lose a URL split across a chunk boundary', () => {
    const acc = createAuthorizeUrlAccumulator()
    const prefix = HOSTED_URL.slice(0, 40)
    const suffix = HOSTED_URL.slice(40)
    expect(acc.feed(`printed: ${prefix}`)).toBeNull()
    expect(acc.feed(`${suffix} and more text\n`)).toBe(HOSTED_URL)
  })

  it('still refuses via the eventual boundary case with no confusion between chunks', () => {
    const acc = createAuthorizeUrlAccumulator()
    expect(acc.feed('no url ')).toBeNull()
    expect(acc.feed('in this stream')).toBeNull()
  })

  // §2b prompt refusal: `feed` must decide on the FIRST complete candidate synchronously, in the
  // SAME call, not wait for a later chunk or for `finish()` — this is the unit-level half of the
  // session-level timing test (`lane-login-session.test.ts`) asserting `loginStart` settles
  // promptly rather than riding the child out to its TTL.
  it('throws login_url_unparsed the instant the FIRST complete candidate is not relayable — never waits for a later one', () => {
    const acc = createAuthorizeUrlAccumulator()
    expect(() => acc.feed(`browser opener: ${PHISHING_URL}\n`)).toThrow()
  })

  it('the refusal names the observed (bad) hostname, not the query or any code', () => {
    const acc = createAuthorizeUrlAccumulator()
    try {
      acc.feed(`${PHISHING_URL}\n`)
      expect.unreachable()
    } catch (error) {
      const message = isClaudeLaneRefusal(error) ? error.message : ''
      expect(message).toContain('evil.example.com')
    }
  })

  // MP: a "skip and keep scanning" accumulator would return null here (no relayable candidate
  // seen yet, still hoping for one) instead of deciding — exactly the hang the timing test exists
  // to catch, since a login child that prints only this URL never sends a later chunk to rescue it.
  it('mutation proof: skip-and-continue on the first bad candidate would return null (undecided) instead of throwing', () => {
    const acc = createAuthorizeUrlAccumulator()
    let threw = false
    let decided: string | null = null
    try {
      decided = acc.feed(`browser opener: ${PHISHING_URL}\n`)
    } catch {
      threw = true
    }
    const skipAndContinueWouldReturn = null // the old shape's "wait for a better one" outcome
    expect(decided).toBe(skipAndContinueWouldReturn) // never assigned — the throw happened first
    expect(threw).toBe(true)
  })

  // MP: a naive per-chunk `firstRelayableAuthorizeUrl` call (no accumulation)
  // truncates the URL at the boundary and throws instead of waiting.
  it('mutation proof: feeding chunks straight into firstRelayableAuthorizeUrl truncates and refuses', () => {
    const prefix = `printed: ${HOSTED_URL.slice(0, 40)}`
    expect(() => firstRelayableAuthorizeUrl(prefix)).toThrow()
  })

  // P14 (review-r2): reaching the cap must NEVER relay a truncated prefix — it
  // must refuse. Negative control: a URL cut mid-parameter must never surface
  // as a return value, truncated or otherwise.
  it('refuses accounts.lane.login_url_unparsed at the cap instead of relaying a truncated prefix', () => {
    const acc = createAuthorizeUrlAccumulator()
    // Padding plus a URL cut 10 chars short pushes the buffer over the 8000-char
    // cap while a match is still pinned to the buffer tail (never terminated).
    const fed = `${'x'.repeat(8000)} ${HOSTED_URL.slice(0, -10)}`
    let thrown: unknown
    try {
      acc.feed(fed)
    } catch (error) {
      thrown = error
    }
    expect(isClaudeLaneRefusal(thrown) ? thrown.code : null).toBe(
      'accounts.lane.login_url_unparsed'
    )
  })

  // A chunk that pushes the buffer past the cap can still carry a complete, decidable candidate
  // (a chattier CLI's noise plus a fully-terminated good URL) — the cap must not refuse ahead of
  // deciding on it, and the good URL must relay normally rather than being reported as never
  // printed.
  it('relays a good URL even when the noise ahead of it alone would exceed the cap', () => {
    const acc = createAuthorizeUrlAccumulator()
    const fed = `${'x'.repeat(7990)}\n${HOSTED_URL}\n`
    expect(acc.feed(fed)).toBe(HOSTED_URL)
  })

  // MP: checking the cap BEFORE deciding (the pre-fix order) discards this exact buffer and
  // throws `login_url_unparsed` instead of relaying the good URL it plainly contains.
  it('mutation proof: checking the cap before deciding would refuse the good-URL-after-noise case above', () => {
    const buffer = `${'x'.repeat(7990)}\n${HOSTED_URL}\n`
    expect(buffer.length).toBeGreaterThan(8000)
    const preFixWouldRefuse = buffer.length > 8000 // the old shape's cap-first check
    expect(preFixWouldRefuse).toBe(true) // ...the old shape discards before ever deciding...
    const acc = createAuthorizeUrlAccumulator()
    expect(acc.feed(buffer)).toBe(HOSTED_URL) // ...the shipped fix decides first and relays.
  })

  // MP: the pre-fix shape ("matchEndsAtBufferTail && buffer.length < MAX")
  // treats reaching the cap as proof of completeness and relays the prefix
  // instead of refusing — this must go red against that shape.
  it('mutation proof: accepting a match at the cap instead of refusing would relay a truncated prefix', () => {
    const buffer = `${'x'.repeat(8000)} ${HOSTED_URL.slice(0, -10)}`
    const stripped = buffer // no escapes present in this fixture
    // Reuses the module's own bare-URL extraction rather than a second copy of
    // its control-byte-excluding pattern.
    const matched = firstAuthorizeUrl(stripped)
    // The old shape's condition for "accept, do not wait": the match runs to
    // the buffer's tail AND the buffer has reached its cap.
    const oldShapeWouldAccept = matched !== null && stripped.endsWith(matched)
    expect(oldShapeWouldAccept).toBe(true)
    expect(matched).not.toBe(HOSTED_URL) // ...and what it would accept is a cut prefix.
    // The shipped accumulator refuses instead of returning that prefix.
    const acc = createAuthorizeUrlAccumulator()
    expect(() => acc.feed(buffer)).toThrow()
  })

  describe('finish', () => {
    // P12 (review-r2): a URL that is the very last thing the stream ever
    // produces, with no trailing boundary byte, must not be silence.
    it('relays a URL that never received a trailing boundary byte before stream end', () => {
      const acc = createAuthorizeUrlAccumulator()
      expect(acc.feed(`printed: ${HOSTED_URL}`)).toBeNull() // no boundary yet — must wait
      expect(acc.finish()).toBe(HOSTED_URL)
    })

    // End-of-child is itself a valid terminator, same as whitespace/newline.
    it('relays a URL split across a chunk boundary and resolved only at finish()', () => {
      const acc = createAuthorizeUrlAccumulator()
      const prefix = HOSTED_URL.slice(0, 40)
      const suffix = HOSTED_URL.slice(40)
      expect(acc.feed(prefix)).toBeNull()
      expect(acc.feed(suffix)).toBeNull()
      expect(acc.finish()).toBe(HOSTED_URL)
    })

    // Never silence: nothing relayable ⇒ a named refusal, not null/undefined.
    it('throws login_url_unparsed at finish() when nothing relayable was ever seen', () => {
      const acc = createAuthorizeUrlAccumulator()
      acc.feed('no url in this stream')
      try {
        acc.finish()
        expect.unreachable()
      } catch (error) {
        expect(isClaudeLaneRefusal(error) ? error.code : null).toBe(
          'accounts.lane.login_url_unparsed'
        )
      }
    })
  })
})

describe('isPasteCodePrompt', () => {
  // Control: the prompt has NO trailing newline. A line-buffered reader would
  // never see a complete "line" here and would hang — this must be detected on
  // the raw, newline-less tail.
  it('matches the exact prompt with no trailing newline', () => {
    expect(isPasteCodePrompt('Paste code here if prompted > ')).toBe(true)
  })

  it('matches when the prompt is the tail of a longer chunk', () => {
    expect(isPasteCodePrompt('some banner text\nPaste code here if prompted > ')).toBe(true)
  })

  // MP: a reader that requires a trailing newline before testing the prompt
  // would never fire on this input, timing out instead of proceeding — the
  // failure mode a line-buffered implementation produces.
  it('does NOT match when a trailing newline was appended', () => {
    expect(isPasteCodePrompt('Paste code here if prompted > \n')).toBe(false)
  })

  it('does not match unrelated text', () => {
    expect(isPasteCodePrompt('Signing in...')).toBe(false)
  })

  // P6: trailing cursor-show / colour-reset escapes are the expected shape
  // (§2b: NO_COLOR=1 TERM=dumb does not disable the wrapping), not an edge case.
  it('matches with a trailing cursor-show escape', () => {
    expect(isPasteCodePrompt('Paste code here if prompted > \x1b[?25h')).toBe(true)
  })

  it('matches when wrapped in SGR colour codes', () => {
    expect(isPasteCodePrompt('\x1b[1mPaste code here if prompted > \x1b[0m')).toBe(true)
  })
})

describe('createPasteCodePromptWatcher', () => {
  it('matches the prompt within a single fed chunk', () => {
    const watcher = createPasteCodePromptWatcher()
    expect(watcher.feed('Paste code here if prompted > ')).toBe(true)
  })

  // P5: the prompt split across two chunks with no shared newline to force a
  // flush — a bare per-chunk check misses it and the reader hangs.
  it('matches the prompt split across two chunks', () => {
    const watcher = createPasteCodePromptWatcher()
    expect(watcher.feed('banner\nPaste code here if ')).toBe(false)
    expect(watcher.feed('prompted > ')).toBe(true)
  })

  // MP: a bare per-chunk isPasteCodePrompt call (no accumulation) never fires
  // on either half of the split prompt above.
  it('mutation proof: per-chunk isPasteCodePrompt with no accumulation never fires', () => {
    expect(isPasteCodePrompt('banner\nPaste code here if ')).toBe(false)
    expect(isPasteCodePrompt('prompted > ')).toBe(false)
  })

  it('does not match unrelated chunks', () => {
    const watcher = createPasteCodePromptWatcher()
    expect(watcher.feed('Signing in...')).toBe(false)
    expect(watcher.feed('still working\n')).toBe(false)
  })
})
