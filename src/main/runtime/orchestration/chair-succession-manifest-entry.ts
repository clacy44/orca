// S10-22a WAVE 2: the one place `chair-succession-seal.ts`/`chair-succession-execute.ts` read a
// manifest entry from. Tolerates the manifest having no `succession`/`launchArgs` fields yet
// (another worker's wave-2 slice adds them to chairs-manifest.ts's own validated shape) — read
// defensively here rather than assume it.
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { OrchestrationError } from './orchestration-error'
import { parseChairsManifest, type ChairsManifestEntry } from './chairs-manifest'
import type { CharterMode } from './chair-succession-types'

export type ManifestEntryWithSuccession = ChairsManifestEntry & {
  succession?: { enabled?: boolean; charterPath?: string; charterMode?: CharterMode }
  launchArgs?: string[]
}

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
