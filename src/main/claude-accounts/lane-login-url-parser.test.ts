import { describe, expect, it } from 'vitest'
import {
  assertRelayableAuthorizeUrl,
  firstAuthorizeUrl,
  isPasteCodePrompt,
  stripOsc8,
  UnrelayableAuthorizeUrlError
} from './lane-login-url-parser'

const HOSTED_URL = `https://platform.claude.com/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/callback'
)}&code_challenge_method=S256`

const LOOPBACK_URL = `https://platform.claude.com/oauth/authorize?client_id=abc&redirect_uri=${encodeURIComponent(
  'http://localhost:54231/callback'
)}`

function osc8Wrap(url: string, label = 'link'): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`
}

describe('stripOsc8', () => {
  it('unwraps an OSC-8 hyperlink to its URL and following text', () => {
    const wrapped = `text before ${osc8Wrap(HOSTED_URL)} text after`
    expect(stripOsc8(wrapped)).toContain(HOSTED_URL)
    expect(stripOsc8(wrapped)).toContain('text after')
  })

  it('leaves plain text with no OSC-8 sequences unchanged', () => {
    expect(stripOsc8('plain text, no escapes')).toBe('plain text, no escapes')
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

  // MP-a: "last URL wins" would return LOOPBACK_URL here instead of HOSTED_URL,
  // because it appears second. A doubled-OSC-8 stream is exactly what the CLI
  // emits (hosted + loopback variants), so the FIRST match must win.
  it('returns the FIRST URL when two URLs are both OSC-8 wrapped in one chunk', () => {
    const doubled = `${osc8Wrap(HOSTED_URL, 'open')} or ${osc8Wrap(LOOPBACK_URL, 'callback')}`
    expect(firstAuthorizeUrl(doubled)).toBe(HOSTED_URL)
  })

  // MP-b (documented, exercised at the caller level in lane-login-session tests):
  // this function must be fed the LIVE stream, never `runClaudeCommand`'s
  // accumulated, tail-truncated buffer (service.ts MAX_COMMAND_OUTPUT_CHARS
  // truncation at :1133-1134) — a URL followed by >4000 chars of later output
  // would vanish from that buffer. Asserted here structurally: this module
  // exposes no "read the whole buffer" entry point, only per-chunk parsing.
  it('parses a URL correctly even when it is followed by a very long tail', () => {
    const longTail = 'x'.repeat(5000)
    expect(firstAuthorizeUrl(`${HOSTED_URL} ${longTail}`)).toBe(HOSTED_URL)
  })
})

describe('assertRelayableAuthorizeUrl', () => {
  it('accepts a URL whose redirect_uri host is platform.claude.com', () => {
    expect(() => assertRelayableAuthorizeUrl(HOSTED_URL)).not.toThrow()
  })

  // MP: relaying the loopback URL is the concrete harm this guards against — a
  // code delivered as a plaintext GET query string to an unauthenticated
  // loopback port on the person's own desktop.
  it('refuses a URL whose redirect_uri host is a localhost loopback', () => {
    expect(() => assertRelayableAuthorizeUrl(LOOPBACK_URL)).toThrow(UnrelayableAuthorizeUrlError)
    try {
      assertRelayableAuthorizeUrl(LOOPBACK_URL)
    } catch (error) {
      expect((error as UnrelayableAuthorizeUrlError).code).toBe('accounts.lane.login_url_unparsed')
    }
  })

  it('refuses a URL with no redirect_uri at all', () => {
    expect(() =>
      assertRelayableAuthorizeUrl('https://platform.claude.com/oauth/authorize')
    ).toThrow(UnrelayableAuthorizeUrlError)
  })

  it('refuses a string that does not parse as a URL', () => {
    expect(() => assertRelayableAuthorizeUrl('not a url at all')).toThrow(
      UnrelayableAuthorizeUrlError
    )
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
})
