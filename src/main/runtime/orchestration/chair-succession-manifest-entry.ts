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

export type { ChairsManifestEntry }
/** @deprecated use `ChairsManifestEntry` from `chairs-manifest.ts` directly. */
export type ManifestEntryWithSuccession = ChairsManifestEntry

export function defaultChairsManifestPath(): string {
  return join(homedir(), '.orca', 'chairs.json')
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
  const machineId = hostname()
  const entry = parsed.manifest.chairs.find(
    (c) => c.name === chairName && (c.host === undefined || c.host === machineId)
  ) as ManifestEntryWithSuccession | undefined
  if (!entry) {
    throw new OrchestrationError(
      'succession_not_a_chair',
      `"${chairName}" is not a manifest chair on this host`
    )
  }
  return entry
}
