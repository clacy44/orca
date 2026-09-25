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

export type ChairsManifestCharterMode = 'reference' | 'embed'

export type ChairsManifestSuccession = {
  enabled: boolean
  charterPath: string
  charterMode?: ChairsManifestCharterMode
}

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
  // [S10-22a Wave 2 contract] owner config for `orca chairs succeed` (D-R215 §Protocol step 1).
  succession?: ChairsManifestSuccession
  // [S10-22a Wave 2 contract, D-R217] passed verbatim, after the agent's own args, by both
  // `chairs restore` and the succession launch. Each element must be newline-free (a newline in
  // an argv element cannot round-trip through the shapes this manifest feeds).
  launchArgs?: string[]
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
  if (entry.succession !== undefined) {
    const problem = validateSuccession(entry.succession, index)
    if (problem) {
      return problem
    }
  }
  if (entry.launchArgs !== undefined) {
    const problem = validateLaunchArgs(entry.launchArgs, index)
    if (problem) {
      return problem
    }
  }
  return null
}

function validateSuccession(raw: unknown, index: number): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return `chairs[${index}].succession must be an object when present`
  }
  const succession = raw as Record<string, unknown>
  if (typeof succession.enabled !== 'boolean') {
    return `chairs[${index}].succession.enabled must be a boolean`
  }
  if (!isNonEmptyString(succession.charterPath)) {
    return `chairs[${index}].succession.charterPath must be a non-empty string`
  }
  if (
    succession.charterMode !== undefined &&
    succession.charterMode !== 'reference' &&
    succession.charterMode !== 'embed'
  ) {
    return `chairs[${index}].succession.charterMode must be "reference" or "embed"`
  }
  return null
}

// [G1-10z L2 repair] launchArgs is typed into an interactive shell (local-pty-shell-ready.ts) —
// \n/\r alone (the pre-repair check) left every OTHER C0 control (e.g. code 3 = SIGINT, code 27
// = ESC for a terminal-escape injection), DEL (code 127) and every C1 control (128-159)
// unrefused. C0 (minus tab, code 9 — a legitimate argv-element separator a shell tokenizer may
// reintroduce) + DEL + C1. A char-code scan, not a regex literal, so the control-character ranges
// below never trip a "control characters in a regex" lint rule this dispatch cannot disable.
function hasForbiddenLaunchArgControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const isC0NonTab = code <= 0x1f && code !== 0x09
    const isDel = code === 0x7f
    const isC1 = code >= 0x80 && code <= 0x9f
    if (isC0NonTab || isDel || isC1) {
      return true
    }
  }
  return false
}

function validateLaunchArgs(raw: unknown, index: number): string | null {
  if (!Array.isArray(raw)) {
    return `chairs[${index}].launchArgs must be an array of strings`
  }
  for (let i = 0; i < raw.length; i += 1) {
    const element = raw[i]
    if (typeof element !== 'string') {
      return `chairs[${index}].launchArgs[${i}] must be a string`
    }
    if (hasForbiddenLaunchArgControlChar(element)) {
      return `chairs[${index}].launchArgs[${i}] must not contain a C0/C1 control character or DEL`
    }
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
