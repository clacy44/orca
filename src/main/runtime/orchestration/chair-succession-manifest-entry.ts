// S10-22a WAVE 2: the one place `chair-succession-seal.ts`/`chair-succession-execute.ts` read a
// manifest entry from. `succession`/`launchArgs` now live directly on chairs-manifest.ts's own
// validated `ChairsManifestEntry` (S10-22a Wave 2 contract), so this module no longer needs its
// own overlay type — `ManifestEntryWithSuccession` is kept as an alias only so the existing
// importers below don't need a rename. `readManifestEntry` still tolerates a manifest entry with
// no `succession` field (that field is optional on `ChairsManifestEntry` itself).
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { OrchestrationError } from './orchestration-error'
import { parseChairsManifest, type ChairsManifestEntry } from './chairs-manifest'
import { chairTargetSessionId } from './chairs-restore-plan'

export type { ChairsManifestEntry }
/** @deprecated use `ChairsManifestEntry` from `chairs-manifest.ts` directly. */
export type ManifestEntryWithSuccession = ChairsManifestEntry

export function defaultChairsManifestPath(): string {
  return join(homedir(), '.orca', 'chairs.json')
}

/** An entry applies on this machine iff `host` is unset or equals `os.hostname()`. */
export function chairAppliesOnThisHost(chair: ChairsManifestEntry): boolean {
  return chair.host === undefined || chair.host === hostname()
}

/** Every manifest chair that applies on this host, read once. Null (never a throw) on a missing,
 * unreadable or invalid manifest — callers treat "cannot tell" as "not a chair" or as
 * "protected" depending on which side is the safe failure for them. */
export async function readHostScopedManifestChairs(): Promise<ChairsManifestEntry[] | null> {
  try {
    const parsed = parseChairsManifest(
      JSON.parse(await readFile(defaultChairsManifestPath(), 'utf8'))
    )
    return parsed.ok ? parsed.manifest.chairs.filter(chairAppliesOnThisHost) : null
  } catch {
    return null
  }
}

/** The host-scoped manifest chair whose resumable session (`lastSessionId ?? conversationId`) is
 * `sessionId`, on this host only. Never throws: a missing, unreadable or invalid manifest is null. */
export async function findHostScopedManifestChairForSession(
  sessionId: string
): Promise<ManifestEntryWithSuccession | null> {
  try {
    const parsed = parseChairsManifest(
      JSON.parse(await readFile(defaultChairsManifestPath(), 'utf8'))
    )
    if (!parsed.ok) {
      return null
    }
    return (
      (parsed.manifest.chairs.find(
        (c) => chairAppliesOnThisHost(c) && chairTargetSessionId(c) === sessionId
      ) as ManifestEntryWithSuccession | undefined) ?? null
    )
  } catch {
    return null
  }
}

/** Like the lenient reader, but a missing manifest is `[]` and any other failure THROWS, so a caller
 * that must fail closed (the agent-sleep guard) cannot mistake "unreadable" for "no chairs". */
export async function readHostScopedManifestChairsStrict(): Promise<ChairsManifestEntry[]> {
  let raw: string
  try {
    raw = await readFile(defaultChairsManifestPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const parsed = parseChairsManifest(JSON.parse(raw))
  if (!parsed.ok) {
    throw new Error(`chairs manifest invalid: ${parsed.reason}`)
  }
  return parsed.manifest.chairs.filter(chairAppliesOnThisHost)
}

export async function readManifestEntry(
  manifestPath: string | undefined,
  chairName: string
): Promise<ManifestEntryWithSuccession> {
  const path = manifestPath ?? defaultChairsManifestPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new OrchestrationError('succession_not_a_chair', `No chairs manifest at ${path}`)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    throw new OrchestrationError('succession_not_a_chair', `${path} is not valid JSON`)
  }
  const parsed = parseChairsManifest(parsedJson)
  if (!parsed.ok) {
    throw new OrchestrationError('succession_not_a_chair', parsed.reason)
  }
  const entry = parsed.manifest.chairs.find(
    (c) => c.name === chairName && chairAppliesOnThisHost(c)
  ) as ManifestEntryWithSuccession | undefined
  if (!entry) {
    throw new OrchestrationError(
      'succession_not_a_chair',
      `"${chairName}" is not a manifest chair on this host`
    )
  }
  return entry
}
