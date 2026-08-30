// S10-2 CONTAINMENT (ruling 4, generalizing S10-1 ruling A2): one sanitizer applied at write
// (db.insertGatedMessage) and again at every render (formatMessagePointerLine,
// formatMessageBanner) so a subject/body/payload/purge-reason that predates the write-side
// sanitizer (a legacy row, an imported federation payload) still cannot inject multiple pane
// lines or terminal escape sequences on the way out. Distinct from
// `orchestration/agent-name-sanitizer.ts`'s `sanitizeDirectoryText`: that one restricts
// directory fields (role, title, display_name) to a printable-ASCII slug; message text is
// free-form human prose and keeps non-ASCII content — only control/escape/newline structure is
// stripped, never the character set at large.
//
// Pure, no I/O — safe to import from `src/shared` on either process side and from `db.ts`
// (which is ratcheted: this file holds the logic, db.ts only calls in).

export type SanitizeMessageTextResult = {
  value: string
  truncated: boolean
}

// Zero-width and bidi-override codepoints: invisible on their own terminal render but can
// reorder or hide adjacent text (the same class of attack ESC/CSI stripping defends against,
// just without needing an escape byte at all).
const ZERO_WIDTH_OR_BIDI_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g

// ECMA-48 CSI: ESC [ params intermediates final. OSC: ESC ] ... terminated by BEL or ST (ESC \).
// Built via RegExp(), not a /.../ literal: a regex literal containing the raw ESC control
// byte trips oxlint's no-control-regex rule (rightly — it is easy to lose track of an
// invisible byte in a text file). String.fromCharCode keeps the byte explicit and visible.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')

function stripEscapeSequences(input: string): string {
  return input.replace(OSC_RE, '').replace(CSI_RE, '')
}

// Shared first pass for both sanitizers below: NFKC-normalize, strip ESC/CSI/OSC sequences and
// zero-width/bidi-override codepoints, drop non-whitespace C0/C1 controls and DEL outright.
// `newline` is what a line-feed/carriage-return collapses to — a space (sanitizeMessageText, so
// stored/rendered text never carries a raw newline) or itself (sanitizeMessageTextForGate, so
// the gate's line-start heading anchor still sees real line breaks).
function normalizeAndStripControls(raw: string, newline: string): string {
  const normalized = raw.normalize('NFKC')
  const escapesStripped = stripEscapeSequences(normalized)

  let stripped = ''
  for (const ch of escapesStripped) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x0d) {
      stripped += newline
      continue
    }
    if (code === 0x09 || code === 0x0b || code === 0x0c) {
      stripped += ' '
      continue
    }
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      // Why: remaining C0/C1 controls and DEL (incl. bare ESC/CSI-introducer bytes any regex
      // pass missed) are dropped outright — they carry no text content to preserve.
      continue
    }
    stripped += ch
  }
  return stripped.replace(ZERO_WIDTH_OR_BIDI_RE, '')
}

/**
 * Pure text sanitizer for message `subject`/`body`/`payload` (and, gated the same way,
 * `purge_reason` / quarantine reason text — S10-2 GATE §, ruling 9). NFKC-normalizes, strips
 * ESC/CSI/OSC terminal sequences and zero-width/bidi-override codepoints, collapses every
 * newline (and other C0 whitespace controls) to a single space, drops remaining non-whitespace
 * C0/C1 controls and DEL outright, collapses whitespace runs, trims, then hard-truncates to
 * `maxLength`. Never throws — a length overage is reported via `truncated`, never refused; the
 * gate (message-body-gate.ts), not this function, is what can refuse a send.
 */
export function sanitizeMessageText(raw: string, maxLength: number): SanitizeMessageTextResult {
  const stripped = normalizeAndStripControls(raw, ' ')
  const collapsed = stripped.replace(/ {2,}/g, ' ').trim()
  const truncated = collapsed.length > maxLength
  const value = truncated ? collapsed.slice(0, maxLength).trimEnd() : collapsed
  return { value, truncated }
}

/**
 * Gate input text (s10-2-spec.md:150 amended): the SAME NFKC-normalize + escape/zero-width/
 * control stripping as `sanitizeMessageText`, but newline-PRESERVING, so it is evaluated by the
 * gate instead of either the raw text or the fully-sanitized (newline-collapsed) text. Raw text
 * alone under-gates: a zero-width codepoint or a fullwidth-Unicode variant can split a HARD
 * heading so it never matches, and this exact normalization pass — applied identically at
 * storage time — reassembles it in the stored/rendered row. Fully-sanitized text alone
 * under-gates the opposite way (ruling 2's original bug): collapsing newlines to spaces destroys
 * h1's line-start anchor for a heading that is not the literal first line. Gating this
 * normalized-but-line-preserving text catches both: it sees what the reader will actually see.
 * Only whitespace RUNS WITHIN a line are collapsed (never across a line break) so h1's anchor —
 * checked per split line — is unaffected either way.
 */
export function sanitizeMessageTextForGate(raw: string): string {
  const stripped = normalizeAndStripControls(raw, '\n')
  return stripped
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .trim()
}

// A5 (s10-3-pact-spec rev 6): payload is structured JSON, so a whole-payload text sanitizer
// would corrupt it (collapsing an embedded newline inside a JSON string, or truncating
// mid-structure). Sanitize each string LEAF recursively instead — keys, object/array shape,
// and non-string leaves (number/boolean/null) are preserved exactly; only string values pass
// through `sanitizeMessageText`. `JSON.parse(JSON.stringify(x))` round-trips by construction.
export function sanitizeMessagePayloadFields(payload: unknown, maxFieldLength: number): unknown {
  if (typeof payload === 'string') {
    return sanitizeMessageText(payload, maxFieldLength).value
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeMessagePayloadFields(item, maxFieldLength))
  }
  if (payload !== null && typeof payload === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = sanitizeMessagePayloadFields(value, maxFieldLength)
    }
    return out
  }
  return payload
}

// Gate input text for a structured payload: every string leaf, one per line, so h1's
// line-start heading anchor still works on multi-field payloads without needing JSON
// punctuation stripped out of the way first.
export function extractPayloadGateText(payload: unknown): string {
  const strings: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value !== null && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(walk)
    }
  }
  walk(payload)
  return strings.join('\n')
}
