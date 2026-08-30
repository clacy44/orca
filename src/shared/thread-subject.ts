// S10-2 SCHEMA §: pure subject derivation, shared by the RPC send path and (later) any caller
// that needs to mint a thread subject the same way. Never used by the v34 backfill — legacy
// rows predate `sanitizeMessageText` and get the fixed literal `(legacy thread)` instead, so
// unsanitized historical text never enters this new render surface (s10-2-spec.md:97).
import { sanitizeMessageText } from './message-text'

export const THREAD_SUBJECT_MAX_LENGTH = 80
const NO_SUBJECT = '(no subject)'

function firstNonEmptyLine(body: string): string {
  for (const line of body.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return ''
}

/** Cuts to `THREAD_SUBJECT_MAX_LENGTH` on a word boundary (never mid-word) and appends '…'
 * when it truncated; an already-short subject is returned unchanged. */
function cutAtWordBoundary(value: string): string {
  if (value.length <= THREAD_SUBJECT_MAX_LENGTH) {
    return value
  }
  const slice = value.slice(0, THREAD_SUBJECT_MAX_LENGTH)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

/**
 * `subject = sanitizeMessageText(explicit ?? firstNonEmptyLine(body))`, collapse whitespace,
 * cut at 80 on a word boundary + '…'; empty -> '(no subject)' (s10-2-spec.md:99).
 */
export function deriveThreadSubject(params: { explicit?: string | null; body: string }): string {
  const source =
    params.explicit !== undefined && params.explicit !== null && params.explicit.trim().length > 0
      ? params.explicit
      : firstNonEmptyLine(params.body)
  const sanitized = sanitizeMessageText(source, THREAD_SUBJECT_MAX_LENGTH * 4)
  if (sanitized.value.length === 0) {
    return NO_SUBJECT
  }
  return cutAtWordBoundary(sanitized.value)
}
