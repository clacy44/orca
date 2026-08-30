// S10-2 GATE §: pure post-time content gate, no I/O — the allowlist is injected by the caller
// so verdicts stay unit-testable and reusable by S10-3's guide tooling. Applied at the single
// choke `db.insertGatedMessage` and at the federation relay encode path, never in the CLI or at
// three separate handler call sites (s10-2-spec.md:149).
//
// HARD tier is anchored to line-start heading/bold-lead-in shape (ruling 6): an inline mention
// or a one-line pass/fail verdict never matches h1, so the refusal's own suggested rewrite is
// always sendable. SOFT tier matches anywhere in the text and never blocks (~75% false-positive
// rate on ordinary security-design prose, s10-2-spec.md:147 — tightening it to HARD closes the
// bus for that prose; do not do it).

export type GateScope = 'send' | 'purge_reason' | 'quarantine_reason'

export type GateVerdict =
  | { tier: 'clean' }
  | { tier: 'soft'; ruleIds: readonly string[] }
  | { tier: 'hard'; ruleIds: readonly string[] }

export type GateInput = {
  subject?: string
  body?: string
  payload?: string
  /** Newline-delimited infra literals, read once by the caller and cached (s10-2-spec.md:150).
   * Absent/empty means h3 is inert — never a startup failure. */
  infraAllowlist?: readonly string[]
}

// h1 — a heading, bold lead-in, or bare all-caps section-opener AT THE START of a line. Never
// matches text appearing mid-sentence. The word list is the ruling-6 anchor set plus the
// broadened cues from the docs-bus gate lesson (SECURITY with ANY trailing punctuation, not only
// "(HIGH|CRITICAL)"; execution-confirmed, EXPLOIT, PoC alongside VULNERABILITY/MERGE-GATE AUDIT).
const HARD_HEADING_RULES: readonly { id: string; re: RegExp }[] = [
  { id: 'merge-gate-audit-heading', re: /^MERGE-GATE\s+AUDIT\b/i },
  { id: 'security-heading', re: /^SECURITY\b\s*[:\-–—,.()[\]]/i },
  { id: 'vulnerability-heading', re: /^VULNERABILITY\b/i },
  { id: 'execution-confirmed-heading', re: /^EXECUTION-CONFIRMED\b/i },
  { id: 'exploit-heading', re: /^EXPLOIT\b/i },
  { id: 'poc-heading', re: /^PoC\b/i }
]

// Provider token shapes (h2a) — deliberately conservative (specific vendor prefixes), so an
// ordinary hex-looking id does not false-positive.
const SECRET_SHAPED_PATTERNS: readonly { id: string; re: RegExp }[] = [
  { id: 'secret-aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'secret-provider-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'secret-provider-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'secret-provider-token', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'secret-private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ }
]

// h2b — KEY=/SECRET=/TOKEN= followed by >=20 non-placeholder characters. Placeholder-shaped
// values (all one repeated char, or common stand-in words) never match — a doc's
// `TOKEN=<your-token-here>` must stay sendable.
const KEY_ASSIGNMENT_RE = /\b(?:KEY|SECRET|TOKEN)\s*=\s*(\S{20,})/gi
const PLACEHOLDER_VALUE_RE =
  /^(.)\1*$|^[<{[].*[>}\]]$|^(?:x+|X+|redacted|change ?me|your[-_ ]?(?:key|token|secret)|example|placeholder|todo|xxxx+)$/i

// Soft tier: attacker/hostile vocabulary (incl. hyphenated forms) and bypass/exploit/backdoor
// vocabulary, matched anywhere in the text. Never promoted to HARD.
const SOFT_RULES: readonly { id: string; re: RegExp }[] = [
  { id: 'attacker-vocabulary', re: /\battacker(?:-[a-z]+)*\b/i },
  { id: 'hostile-vocabulary', re: /\bhostile(?:-[a-z]+)*\b/i },
  { id: 'bypass-vocabulary', re: /\bbypass(?:ed|es|ing)?\b/i },
  { id: 'exploit-vocabulary', re: /\bexploit(?:ed|s|ing|able)?\b/i },
  { id: 'backdoor-vocabulary', re: /\bbackdoor(?:ed|s)?\b/i }
]

function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUE_RE.test(value)
}

function fieldTexts(input: GateInput): readonly string[] {
  return [input.subject, input.body, input.payload].filter(
    (t): t is string => typeof t === 'string' && t.length > 0
  )
}

function matchHardHeadings(text: string): string[] {
  const ids = new Set<string>()
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim()
    // Strip a leading markdown heading marker or bold lead-in so the phrase check always
    // lands on the opener content itself, not on '#'/'*' punctuation.
    const opener = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\*\*([^*]+)\*\*.*$/, '$1')
      .trim()
    for (const rule of HARD_HEADING_RULES) {
      if (rule.re.test(opener)) {
        ids.add(rule.id)
      }
    }
  }
  return [...ids]
}

function matchSecretShaped(text: string): string[] {
  const ids = new Set<string>()
  for (const rule of SECRET_SHAPED_PATTERNS) {
    if (rule.re.test(text)) {
      ids.add(rule.id)
    }
  }
  KEY_ASSIGNMENT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KEY_ASSIGNMENT_RE.exec(text)) !== null) {
    if (!isPlaceholderValue(m[1])) {
      ids.add('secret-shaped-value')
    }
  }
  return [...ids]
}

function matchInfraLiterals(text: string, allowlist: readonly string[]): string[] {
  const ids: string[] = []
  for (const literal of allowlist) {
    if (literal.length > 0 && text.includes(literal)) {
      ids.push('infra-literal')
      break
    }
  }
  return ids
}

function matchSoft(text: string): string[] {
  const ids = new Set<string>()
  for (const rule of SOFT_RULES) {
    if (rule.re.test(text)) {
      ids.add(rule.id)
    }
  }
  return [...ids]
}

/** Evaluates the HARD tier first (any match refuses the whole message, tier='hard'); when clean
 * of HARD, evaluates SOFT (any match flags but still delivers, tier='soft'); otherwise 'clean'.
 * Rule ids are the only thing ever returned — never matched text, offsets, or the literal an
 * allowlist entry matched (s10-2-spec.md:150). */
export function evaluateMessageBodyGate(input: GateInput): GateVerdict {
  const texts = fieldTexts(input)
  const allowlist = input.infraAllowlist ?? []

  const hardIds = new Set<string>()
  for (const text of texts) {
    for (const id of matchHardHeadings(text)) {
      hardIds.add(id)
    }
    for (const id of matchSecretShaped(text)) {
      hardIds.add(id)
    }
    for (const id of matchInfraLiterals(text, allowlist)) {
      hardIds.add(id)
    }
  }
  if (hardIds.size > 0) {
    return { tier: 'hard', ruleIds: [...hardIds] }
  }

  const softIds = new Set<string>()
  for (const text of texts) {
    for (const id of matchSoft(text)) {
      softIds.add(id)
    }
  }
  if (softIds.size > 0) {
    return { tier: 'soft', ruleIds: [...softIds] }
  }

  return { tier: 'clean' }
}
