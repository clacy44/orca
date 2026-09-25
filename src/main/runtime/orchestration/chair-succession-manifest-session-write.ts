// S10-22a G1 repair round: split out of chair-succession-accept.ts (line ratchet) — the manifest
// `lastSessionId` write accept's confirm tail runs BEFORE `confirmed` (G1 repair M5).
import { readFile } from 'node:fs/promises'
import { withPaneLock } from '../../ipc/agent-launch-admission-lock'
import { parseChairsManifest, type ChairsManifest } from './chairs-manifest'
import { writeFileAtomic, pathExists } from '../rpc/methods/chairs-restore'
import { defaultChairsManifestPath } from './chair-succession-manifest-entry'

/** G1 attempt-3 repair F8: every no-write path used to return silently (ACCEPTED with no flag,
 * no warning — restore then fell back to `conversationId`). `ok: false` covers every one of
 * them: null session id, missing/unparseable manifest, absent chair entry. `skipped` distinguishes
 * the one legitimate no-op (the manifest already holds this exact session id) from a failure. */
export type WriteManifestSessionIdResult =
  | { ok: true; skipped?: 'already_current' }
  | { ok: false; reason: string }

export async function writeManifestLastSessionId(
  manifestPath: string | undefined,
  hostId: string,
  chair: string,
  sessionId: string | null
): Promise<WriteManifestSessionIdResult> {
  if (!sessionId) {
    return { ok: false, reason: 'null_session_id' }
  }
  const path = manifestPath ?? defaultChairsManifestPath()
  // [Wave 2 contract A7] restore/export/succession share ONE lock key `chairs-manifest:<host>` via
  // `withPaneLock` (restore/export wiring: chairs-restore.ts, this G1 repair round).
  return withPaneLock(
    `chairs-manifest:${hostId}`,
    async (): Promise<WriteManifestSessionIdResult> => {
      if (!(await pathExists(path))) {
        return { ok: false, reason: 'manifest_missing' }
      }
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch {
        return { ok: false, reason: 'manifest_unreadable' }
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(raw)
      } catch {
        return { ok: false, reason: 'manifest_unparseable' }
      }
      const parsed = parseChairsManifest(parsedJson)
      if (!parsed.ok) {
        return { ok: false, reason: 'manifest_invalid' }
      }
      const manifest: ChairsManifest = parsed.manifest
      const manifestEntry = manifest.chairs.find((c) => c.name === chair)
      if (!manifestEntry) {
        return { ok: false, reason: 'chair_entry_absent' }
      }
      if (manifestEntry.lastSessionId === sessionId) {
        return { ok: true, skipped: 'already_current' }
      }
      manifestEntry.lastSessionId = sessionId
      await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
      return { ok: true }
    }
  )
}
