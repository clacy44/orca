// S10-1 CONTAINMENT #3/#4: one sanitizer, used at write (register) and again at every render
// (list/find/show text and JSON, and S10-2's pane push). Restricting the output charset to
// printable ASCII in one pass neutralizes ESC/CSI/OSC sequences, \r/\n, zero-width and bidi
// override codepoints, and homoglyph impersonation all at once — no per-attack-class rule.

export const DIRECTORY_ROLE_MAX_LENGTH = 120
export const DIRECTORY_TITLE_MAX_LENGTH = 120

// display_name bounds (CONTAINMENT #4): ASCII slug, 3-32 chars total, no leading/trailing
// hyphen; '@' and ':' are structurally excluded (reserved for name@host / agent:<id>).
export const DISPLAY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

export const RESERVED_DISPLAY_NAMES: ReadonlySet<string> = new Set([
  'all',
  'idle',
  'everyone',
  'here',
  'run',
  'dispatch',
  'agent',
  'worktree',
  'system',
  'orca',
  'owner',
  'coordinator'
])

export type SanitizedText = { value: string; truncated: boolean }

/**
 * Pure text sanitizer for free-text directory fields (role, title). NFKC-normalizes, then
 * collapses every codepoint outside printable ASCII (0x20-0x7E) to a space — this single
 * filter strips C0/C1 controls, ESC, CSI/OSC, \r, \n, zero-width (U+200B-200F, U+FEFF) and
 * bidi override (U+202A-202E, U+2066-2069) codepoints, and non-ASCII homoglyphs in one pass.
 * Collapses runs of whitespace, trims, then truncates to maxLength (word-boundary trim of the
 * cut). Never throws; a length overage is reported via `truncated`, never refused.
 */
export function sanitizeDirectoryText(raw: string, maxLength: number): SanitizedText {
  const normalized = raw.normalize('NFKC')
  let asciiOnly = ''
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0
    asciiOnly += code >= 0x20 && code <= 0x7e ? ch : ' '
  }
  const collapsed = asciiOnly.replace(/\s+/g, ' ').trim()
  const truncated = collapsed.length > maxLength
  const value = truncated ? collapsed.slice(0, maxLength).trimEnd() : collapsed
  return { value, truncated }
}

export function sanitizeRole(raw: string | null | undefined): SanitizedText | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const sanitized = sanitizeDirectoryText(raw, DIRECTORY_ROLE_MAX_LENGTH)
  return sanitized.value.length > 0 ? sanitized : null
}

export function sanitizeTitle(raw: string | null | undefined): SanitizedText | null {
  if (raw === null || raw === undefined) {
    return null
  }
  const sanitized = sanitizeDirectoryText(raw, DIRECTORY_TITLE_MAX_LENGTH)
  return sanitized.value.length > 0 ? sanitized : null
}

export type DisplayNameValidation =
  | { ok: true }
  | { ok: false; reasonCode: 'invalid_charset' | 'double_hyphen' | 'reserved' }

/**
 * Validates a display_name candidate against the spec's bounds. This is NOT a sanitizer —
 * an invalid candidate is refused (by the caller), never silently rewritten, so the RPC layer
 * can hand back a concrete alternative rather than a name the caller didn't choose.
 */
export function validateDisplayNameCandidate(candidate: string): DisplayNameValidation {
  if (candidate.includes('--')) {
    return { ok: false, reasonCode: 'double_hyphen' }
  }
  if (!DISPLAY_NAME_PATTERN.test(candidate)) {
    return { ok: false, reasonCode: 'invalid_charset' }
  }
  if (RESERVED_DISPLAY_NAMES.has(candidate)) {
    return { ok: false, reasonCode: 'reserved' }
  }
  return { ok: true }
}
