// S10-22a G1 repair round: split out of chair-succession-store.ts (line ratchet) — the
// multi-record read accessor.
import { readdir } from 'node:fs/promises'
import { read, successionsRoot, type ChairSuccessionStoreDeps } from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'

/** All successions for `chair` currently in `sealed`, `launching` or `confirming` state.
 * Read-only, no lock. G1 repair N5: `confirming` counts as in flight too — a second seal must
 * not be admitted while an accept is still finishing its takeover. */
export async function listActive(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<SuccessionMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(successionsRoot(deps, chair))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const active: SuccessionMeta[] = []
  for (const id of entries) {
    const meta = await read(deps, chair, id)
    if (
      meta &&
      (meta.state === 'sealed' || meta.state === 'launching' || meta.state === 'confirming')
    ) {
      active.push(meta)
    }
  }
  return active
}

/** [G1-10z polish-recheck N3 repair] every delivery id that landed (acknowledged) on a PAST
 * aborted seal for `chair`, across every aborted record on disk — a retry's `--ack` is safe to
 * repeat exactly these; nothing else, even if acknowledged for an unrelated reason. Read-only,
 * no lock (same snapshot-read reasoning as `listActive`). */
export async function collectAbortedLandedAckIds(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<Set<string>> {
  let entries: string[]
  try {
    entries = await readdir(successionsRoot(deps, chair))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw error
  }
  const landed = new Set<string>()
  for (const id of entries) {
    const meta = await read(deps, chair, id)
    if (meta && meta.state === 'aborted' && meta.landedAckIds) {
      for (const ackId of meta.landedAckIds) {
        landed.add(ackId)
      }
    }
  }
  return landed
}
