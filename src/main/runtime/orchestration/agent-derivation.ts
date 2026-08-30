// S10-1 CONTAINMENT #6: derived rows never launder agent-controlled text into identity.
// display_name = slug(branch || worktree basename) + '-' + slug(getAgentLabel(title)) + '-'
// + 4 hex. Branch and worktree path are host-controlled (git forbids control characters in
// refs); `title` is agent-controlled and is used ONLY to look up a coarse product label
// ("Claude Code" -> "claude-code") via the same module the roster imports — never as literal
// text in the name. The sanitized title is stored and scored (agent-name-sanitizer.ts), never
// promoted to a name.
import { randomBytes } from 'node:crypto'
import { getAgentLabel } from '../../../shared/terminal-title-agent-type'
import { DISPLAY_NAME_PATTERN } from './agent-name-sanitizer'

const DISPLAY_NAME_MAX_LENGTH = 32
const DERIVED_NAME_SEPARATORS = 2 // the two '-' joins
const FALLBACK_BASE_SLUG = 'terminal'
const FALLBACK_LABEL_SLUG = 'agent'

function slugify(raw: string, fallback: string): string {
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // drop combining diacritics after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : fallback
}

function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

function randomSuffixHex(): string {
  return randomBytes(2).toString('hex')
}

/** Coarse product label slug from a pane title, e.g. "Claude Code" -> "claude-code". Never the
 * literal title text; unrecognized/injected titles fall back to the generic "agent" slug. */
export function deriveAgentLabelSlug(title: string | null): string {
  const label = title ? getAgentLabel(title) : null
  return label ? slugify(label, FALLBACK_LABEL_SLUG) : FALLBACK_LABEL_SLUG
}

function fitWithinBudget(basePart: string, labelPart: string, hex: string): string {
  const budget = DISPLAY_NAME_MAX_LENGTH - hex.length - DERIVED_NAME_SEPARATORS
  let label = labelPart.slice(0, Math.max(1, Math.min(labelPart.length, budget - 1)))
  let base = basePart.slice(0, Math.max(1, budget - label.length))
  const trimHyphens = (s: string, fallback: string): string => {
    const trimmed = s.replace(/^-+|-+$/g, '')
    return trimmed.length > 0 ? trimmed : fallback
  }
  base = trimHyphens(base, FALLBACK_BASE_SLUG.slice(0, Math.max(1, budget - label.length)))
  label = trimHyphens(label, FALLBACK_LABEL_SLUG.slice(0, Math.max(1, budget - base.length)))
  return `${base}-${label}-${hex}`.replace(/-{2,}/g, '-')
}

export type DerivedAgentNameInput = {
  branch: string | null
  worktreePath: string | null
  title: string | null
}

/** Derives a display_name for an unregistered (derived) row. Always produces a name that
 * satisfies DISPLAY_NAME_PATTERN — callers may assert this without re-validating. */
export function deriveDisplayName(input: DerivedAgentNameInput): string {
  const nameSource = input.branch ?? (input.worktreePath ? pathBasename(input.worktreePath) : null)
  const base = slugify(nameSource ?? '', FALLBACK_BASE_SLUG)
  const label = deriveAgentLabelSlug(input.title)
  const hex = randomSuffixHex()
  const candidate = `${base}-${label}-${hex}`
  const fitted =
    candidate.length <= DISPLAY_NAME_MAX_LENGTH ? candidate : fitWithinBudget(base, label, hex)
  // Belt: the fitted name is constructed from already-slugified, hyphen-trimmed parts joined
  // by single hyphens, so it should always match; guard against a pathological fallback string.
  return DISPLAY_NAME_PATTERN.test(fitted)
    ? fitted
    : `${FALLBACK_BASE_SLUG}-${FALLBACK_LABEL_SLUG}-${hex}`
}
