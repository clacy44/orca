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

const HOSTED_URL = `https://platform.claude.com/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}&code_challenge_method=S256`

const LOOPBACK_URL = `https://platform.claude.com/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
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
const DOWNGRADED_REDIRECT_URL = `https://platform.claude.com/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
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
  it('accepts a URL whose own origin and redirect_uri are both platform.claude.com', () => {
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
  it('refuses a URL whose own origin is not platform.claude.com (P1)', () => {
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

  // P3 / §5 "Printed URL only": a stream that also carries the loopback variant,
  // printed FIRST, must still relay the hosted one — selection and validation
  // are one operation, not "take the first match, then assert it".
  it('relays the hosted URL even when a non-relayable loopback URL is printed first', () => {
    const stream = `browser opener: ${LOOPBACK_URL}\nprinted: ${HOSTED_URL}\n`
    expect(firstRelayableAuthorizeUrl(stream)).toBe(HOSTED_URL)
  })

  // P8: an unrelated banner URL precedes the real authorize URL.
  it('skips an unrelated banner URL and relays the authorize URL that follows', () => {
    const stream = `Learn more at https://docs.claude.com/cli\n${HOSTED_URL}\n`
    expect(firstRelayableAuthorizeUrl(stream)).toBe(HOSTED_URL)
  })

  // MP: "first match, then assert" (the pre-fix decomposition) would pick the
  // loopback/banner URL here and throw instead of relaying the hosted one.
  it('mutation proof: picking the first URL of any kind (not first relayable) fails both ordering cases', () => {
    const loopbackFirst = `browser opener: ${LOOPBACK_URL}\nprinted: ${HOSTED_URL}\n`
    const bannerFirst = `Learn more at https://docs.claude.com/cli\n${HOSTED_URL}\n`
    const naiveFirstOfAnyKind = (text: string): string | null => firstAuthorizeUrl(text)
    expect(naiveFirstOfAnyKind(loopbackFirst)).not.toBe(HOSTED_URL)
    expect(naiveFirstOfAnyKind(bannerFirst)).not.toBe(HOSTED_URL)
    // ...while the fixed selection gets both right.
    expect(firstRelayableAuthorizeUrl(loopbackFirst)).toBe(HOSTED_URL)
    expect(firstRelayableAuthorizeUrl(bannerFirst)).toBe(HOSTED_URL)
  })

  it('refuses when no candidate in the text is relayable', () => {
    expect(() => firstRelayableAuthorizeUrl(`only this: ${LOOPBACK_URL}`)).toThrow()
    try {
      firstRelayableAuthorizeUrl('no url at all here')
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

  // MP: a naive per-chunk `firstRelayableAuthorizeUrl` call (no accumulation)
  // truncates the URL at the boundary and throws instead of waiting.
  it('mutation proof: feeding chunks straight into firstRelayableAuthorizeUrl truncates and refuses', () => {
    const prefix = `printed: ${HOSTED_URL.slice(0, 40)}`
    expect(() => firstRelayableAuthorizeUrl(prefix)).toThrow()
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
