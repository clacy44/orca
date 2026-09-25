// S10-22a WAVE 1 (b1-slice1-succession.md rule list; D-R215 §Protocol step 3 "checkpoint
// re-read + sha + validated"): the checkpoint format's whole validation, in one pure function.
// Order of checks below is deliberate (schema → structural line shapes → heading structure →
// size → per-section blankness → secret shapes → unsupported claims) so that a fixture built to
// red-prove one rule cannot accidentally trip an earlier one first; it is not itself part of the
// contract (a checkpoint with two defects reports whichever this order reaches first).
import { createHash } from 'node:crypto'
import {
  CHECKPOINT_SECTION_ORDER,
  CHECKPOINT_SECTION_TITLES,
  type CheckpointSections
} from './chair-succession-types'

export const CHECKPOINT_SCHEMA_LINE = 'schema: orca.chair-checkpoint/1'

export type ChairCheckpointErrorCode =
  | 'checkpoint_schema'
  | 'checkpoint_sections'
  | 'checkpoint_empty_section'
  | 'checkpoint_fence_line'
  | 'checkpoint_tag_line'
  | 'checkpoint_too_large'
  | 'checkpoint_secret_shape'
  | 'checkpoint_unsupported_claim'

export type ChairCheckpointError = {
  code: ChairCheckpointErrorCode
  reason: string
  line?: number
}

export type ChairCheckpointResult =
  | { ok: true; sections: CheckpointSections; sha256: string; bytes: number }
  | { ok: false; error: ChairCheckpointError }

export type EmbeddedCharterValidationResult =
  | { ok: true }
  | { ok: false; error: ChairCheckpointError }

const PER_SECTION_CAP_BYTES = 8 * 1024
const TOTAL_CAP_BYTES = 32 * 1024

// [G1-10z L1 repair] `^(```|~~~)` missed a fence indented 0-3 spaces — Markdown itself still
// treats an indented (<4 spaces) fence delimiter as a real fence, and the render this checkpoint
// is embedded in wraps the whole document in a 3-backtick (or matching) fence, so an indented
// fence line inside the checkpoint still closes it early. `\s*` covers any leading whitespace,
// not just up to 3 spaces — 4+ spaces of indent makes it a code block in CommonMark, never a
// fence, but refusing it too is strictly safer and costs nothing real checkpoints need.
// H10 (G1-10z attempt-4): `\s` excludes Unicode format characters (Cf) — a zero-width space
// (U+200B), word joiner (U+2060), BOM/ZWNBSP (U+FEFF) or any other Cf codepoint placed before the
// fence/tag delimiter rendered invisibly but still passed both validators unseen (probe p3b). Not
// a line-break gap (F9 already covers every Unicode mandatory break) — this is an invisible
// PREFIX on the SAME line. `\p{Cf}` (needs the `u` flag) covers the whole category, not just the
// two measured.
const FENCE_LINE_RE = /^[\s\p{Cf}]*(```|~~~)/u
// A run of 4+ backticks ANYWHERE in a line (not just at line start) still closes this
// checkpoint's own render fence, which uses backticks — `~~~` fences are unaffected by a
// backtick run, so only backticks are checked here; the FENCE_LINE_RE above already catches an
// indented ~~~ line-start fence.
const BACKTICK_RUN_RE = /`{4,}/
const TAG_LINE_RE = /^[\s\p{Cf}]*<[A-Za-z!?/]/u
// G1 attempt-3 repair F9: the fence/tag rules above only ever saw what `.split('\n')` produced —
// a tag line hidden behind a bare CR, U+2028 (LINE SEPARATOR), U+2029 (PARAGRAPH SEPARATOR), VT
// or FF (every line ending CommonMark itself recognizes, besides `\n`/`\r\n`) passed both
// validators unseen and landed verbatim in the rendered context. Split on all of them.
const LINE_SPLIT_RE = /\r\n?|\n|\u2028|\u2029|\v|\f|\u0085/
const OWNER_CLAIM_RE = /\bowner\b/i
const OWNER_CLAIM_VERB_RE = /\b(approved|ratified|authorized|authorised)\b/i
const MESSAGE_ID_RE = /\bmsg_[0-9a-f]{12}\b/

// Credential shapes refused wherever they appear (rule 7): private-key PEM blocks, Anthropic and
// GitHub token prefixes, AWS access-key ids, an orca pairing code, and any long bearer token.
const SECRET_SHAPE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-ant-/,
  /ghp_[A-Za-z0-9]+/,
  /AKIA[0-9A-Z]{12,}/,
  /orca:\/\/pair\?code=/,
  /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/
]

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function fail(
  code: ChairCheckpointErrorCode,
  reason: string,
  line?: number
): ChairCheckpointResult {
  return { ok: false, error: line === undefined ? { code, reason } : { code, reason, line } }
}

/** Rules 4 and 5: no fence-delimiter line (at any indent) and no tag-shaped line anywhere in the
 * document, and no run of 4+ backticks anywhere on a line — the checkpoint is embedded inside a
 * fence when rendered, and must never smuggle a system tag or close that fence early. */
function findLineShapeViolation(lines: string[]): ChairCheckpointResult | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (FENCE_LINE_RE.test(line)) {
      return fail('checkpoint_fence_line', 'a line begins with ``` or ~~~ (any indent)', i + 1)
    }
    if (BACKTICK_RUN_RE.test(line)) {
      return fail('checkpoint_fence_line', 'a line contains a run of 4 or more backticks', i + 1)
    }
    if (TAG_LINE_RE.test(line)) {
      return fail('checkpoint_tag_line', 'a line is shaped like a tag', i + 1)
    }
  }
  return null
}

/** [G1-10z L1 repair] The embedded charter (charterMode === 'embed') is rendered into the SAME
 * fenced resume context the checkpoint is, so it must be refused by the same fence/backtick-run
 * rules — before this repair, only the checkpoint was ever checked; an embedded charter with a
 * closing fence or a 4+ backtick run could break out of the render exactly the same way. Not the
 * full `parseChairCheckpoint` contract (no schema line, no `## ` sections, no secret/claim
 * scan) — a charter is prose, not a checkpoint. */
export function validateEmbeddedCharterText(text: string): EmbeddedCharterValidationResult {
  const lines = text.split(LINE_SPLIT_RE)
  const violation = findLineShapeViolation(lines)
  return violation && !violation.ok ? violation : { ok: true }
}

type HeadingIndex = { key: keyof CheckpointSections; lineIndex: number }

/** Rule 2: exactly eight `## ` headings, in order, with the exact titles. Returns the located
 * headings on success so the caller can slice section bodies from them. */
function locateHeadings(lines: string[]): HeadingIndex[] | ChairCheckpointResult {
  const found: { title: string; lineIndex: number }[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) {
      found.push({ title: lines[i].slice(3), lineIndex: i })
    }
  }
  if (found.length !== CHECKPOINT_SECTION_ORDER.length) {
    return fail(
      'checkpoint_sections',
      `expected exactly ${CHECKPOINT_SECTION_ORDER.length} "## " headings, found ${found.length}`
    )
  }
  const headings: HeadingIndex[] = []
  for (let i = 0; i < CHECKPOINT_SECTION_ORDER.length; i += 1) {
    const key = CHECKPOINT_SECTION_ORDER[i]
    const expectedTitle = CHECKPOINT_SECTION_TITLES[key]
    const { title, lineIndex } = found[i]
    if (title !== expectedTitle) {
      return fail(
        'checkpoint_sections',
        `heading ${i + 1} must be "## ${expectedTitle}", found "## ${title}"`,
        lineIndex + 1
      )
    }
    headings.push({ key, lineIndex })
  }
  return headings
}

function sectionBody(lines: string[], headings: HeadingIndex[], index: number): string {
  const start = headings[index].lineIndex + 1
  const end = index + 1 < headings.length ? headings[index + 1].lineIndex : lines.length
  return lines.slice(start, end).join('\n').trim()
}

function findSecretShape(text: string): RegExpMatchArray | null {
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      return match
    }
  }
  return null
}

/** Rule 8: an "Unsaved rulings" line claiming owner approval must cite a message id. */
function findUnsupportedClaimLine(unsavedRulings: string): string | null {
  if (unsavedRulings === 'none') {
    return null
  }
  for (const line of unsavedRulings.split('\n')) {
    if (OWNER_CLAIM_RE.test(line) && OWNER_CLAIM_VERB_RE.test(line) && !MESSAGE_ID_RE.test(line)) {
      return line
    }
  }
  return null
}

export function parseChairCheckpoint(text: string): ChairCheckpointResult {
  const bytes = byteLength(text)
  if (bytes > TOTAL_CAP_BYTES) {
    return fail('checkpoint_too_large', `total size ${bytes} bytes exceeds ${TOTAL_CAP_BYTES}`)
  }

  const lines = text.split(LINE_SPLIT_RE)

  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstNonEmptyIndex === -1 || lines[firstNonEmptyIndex] !== CHECKPOINT_SCHEMA_LINE) {
    return fail(
      'checkpoint_schema',
      `first non-empty line must be exactly "${CHECKPOINT_SCHEMA_LINE}"`,
      firstNonEmptyIndex === -1 ? undefined : firstNonEmptyIndex + 1
    )
  }

  const lineShapeViolation = findLineShapeViolation(lines)
  if (lineShapeViolation) {
    return lineShapeViolation
  }

  const headings = locateHeadings(lines)
  if (!Array.isArray(headings)) {
    return headings
  }

  const sections = {} as CheckpointSections
  for (let i = 0; i < headings.length; i += 1) {
    const key = headings[i].key
    const body = sectionBody(lines, headings, i)
    if (byteLength(body) > PER_SECTION_CAP_BYTES) {
      return fail(
        'checkpoint_too_large',
        `section "${CHECKPOINT_SECTION_TITLES[key]}" exceeds ${PER_SECTION_CAP_BYTES} bytes`,
        headings[i].lineIndex + 1
      )
    }
    if (body.length === 0) {
      return fail(
        'checkpoint_empty_section',
        `section "${CHECKPOINT_SECTION_TITLES[key]}" is blank (use "none")`,
        headings[i].lineIndex + 1
      )
    }
    sections[key] = body
  }

  const secretMatch = findSecretShape(text)
  if (secretMatch) {
    const lineIndex = lines.findIndex((line) => line.includes(secretMatch[0]))
    return fail(
      'checkpoint_secret_shape',
      'the checkpoint contains a credential-shaped string',
      lineIndex === -1 ? undefined : lineIndex + 1
    )
  }

  const unsupportedClaimLine = findUnsupportedClaimLine(sections.unsavedRulings)
  if (unsupportedClaimLine !== null) {
    const lineIndex = lines.indexOf(unsupportedClaimLine)
    return fail(
      'checkpoint_unsupported_claim',
      'a line in "Unsaved rulings" claims owner approval without citing a msg_ id',
      lineIndex === -1 ? undefined : lineIndex + 1
    )
  }

  return {
    ok: true,
    sections,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes
  }
}
