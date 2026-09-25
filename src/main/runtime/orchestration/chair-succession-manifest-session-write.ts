// S10-22a G1 repair round: split out of chair-succession-accept.ts (line ratchet) — the manifest
// `lastSessionId` write accept's confirm tail runs BEFORE `confirmed` (G1 repair M5).
import { readFile } from 'node:fs/promises'
import { withPaneLock } from '../../ipc/agent-launch-admission-lock'
import { parseChairsManifest, type ChairsManifest } from './chairs-manifest'
import { writeFileAtomic, pathExists } from '../rpc/methods/chairs-restore'
import { defaultChairsManifestPath } from './chair-succession-manifest-entry'

export async function writeManifestLastSessionId(
  manifestPath: string | undefined,
  hostId: string,
  chair: string,
  sessionId: string | null
): Promise<void> {
  if (!sessionId) {
    return
  }
  const path = manifestPath ?? defaultChairsManifestPath()
  // [Wave 2 contract A7] restore/export/succession share ONE lock key `chairs-manifest:<host>` via
  // `withPaneLock` (restore/export wiring: chairs-restore.ts, this G1 repair round).
  await withPaneLock(`chairs-manifest:${hostId}`, async () => {
    if (!(await pathExists(path))) {
      return
    }
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseChairsManifest(parsedJson)
    if (!parsed.ok) {
      return
    }
    const manifest: ChairsManifest = parsed.manifest
    const manifestEntry = manifest.chairs.find((c) => c.name === chair)
    if (!manifestEntry || manifestEntry.lastSessionId === sessionId) {
      return
    }
    manifestEntry.lastSessionId = sessionId
    await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
  })
}
