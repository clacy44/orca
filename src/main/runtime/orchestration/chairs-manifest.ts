// S10-21d b4 (design-r105-r112 ITEM 2 D2; s10-21d-design-v1 DEC-2/DEC-9): the `~/.orca/chairs.json`
// manifest shape and its whole-file validation. `orca chairs restore` reads a manifest, resumes
// every chair it names, and writes `lastSessionId` back — this module is the one place that
// shape is parsed, so a malformed entry anywhere refuses the WHOLE file rather than acting on a
// partial read (spec: "refuse the whole file on any malformed entry (never partial)").
export const CHAIRS_MANIFEST_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode'
] as const
export type ChairsManifestEffort = (typeof CHAIRS_MANIFEST_EFFORTS)[number]

export type ChairsManifestEntry = {
  name: string
  role?: string
  worktree: string
  agent: 'claude'
  conversationId: string
  lastSessionId?: string
  host?: string
  model?: string
  effort?: ChairsManifestEffort
}

export type ChairsManifest = {
  version: 1
  chairs: ChairsManifestEntry[]
}

export type ChairsManifestParseResult =
  | { ok: true; manifest: ChairsManifest }
  | { ok: false; reason: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validateEntry(raw: unknown, index: number): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return `chairs[${index}] is not an object`
  }
  const entry = raw as Record<string, unknown>
  if (!isNonEmptyString(entry.name)) {
    return `chairs[${index}].name must be a non-empty string`
  }
  if (!isNonEmptyString(entry.worktree)) {
    return `chairs[${index}].worktree must be a non-empty string`
  }
  if (entry.agent !== 'claude') {
    return `chairs[${index}].agent must be "claude"`
  }
  if (!isNonEmptyString(entry.conversationId)) {
    return `chairs[${index}].conversationId must be a non-empty string`
  }
  if (entry.role !== undefined && typeof entry.role !== 'string') {
    return `chairs[${index}].role must be a string when present`
  }
  if (entry.lastSessionId !== undefined && !isNonEmptyString(entry.lastSessionId)) {
    return `chairs[${index}].lastSessionId must be a non-empty string when present`
  }
  if (entry.host !== undefined && !isNonEmptyString(entry.host)) {
    return `chairs[${index}].host must be a non-empty string when present`
  }
  if (entry.model !== undefined && !isNonEmptyString(entry.model)) {
    return `chairs[${index}].model must be a non-empty string when present`
  }
  if (
    entry.effort !== undefined &&
    !CHAIRS_MANIFEST_EFFORTS.includes(entry.effort as ChairsManifestEffort)
  ) {
    return `chairs[${index}].effort must be one of ${CHAIRS_MANIFEST_EFFORTS.join('|')}`
  }
  return null
}

/** Refuses the whole file (never a partial acceptance) on any malformed entry or shape. */
export function parseChairsManifest(raw: unknown): ChairsManifestParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'manifest must be a JSON object' }
  }
  const candidate = raw as Record<string, unknown>
  if (candidate.version !== 1) {
    return { ok: false, reason: 'manifest.version must be 1' }
  }
  if (!Array.isArray(candidate.chairs)) {
    return { ok: false, reason: 'manifest.chairs must be an array' }
  }
  const names = new Set<string>()
  for (let i = 0; i < candidate.chairs.length; i += 1) {
    const problem = validateEntry(candidate.chairs[i], i)
    if (problem) {
      return { ok: false, reason: problem }
    }
    const name = (candidate.chairs[i] as ChairsManifestEntry).name
    if (names.has(name)) {
      return { ok: false, reason: `chairs[${i}].name "${name}" is a duplicate` }
    }
    names.add(name)
  }
  return { ok: true, manifest: candidate as ChairsManifest }
}
