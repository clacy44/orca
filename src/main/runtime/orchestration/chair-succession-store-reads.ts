// S10-22a G1 repair round: split out of chair-succession-store.ts (line ratchet) — the
// multi-record read accessor.
import { readdir } from 'node:fs/promises'
import { read, successionsRoot, type ChairSuccessionStoreDeps } from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'

/** All successions for `chair` currently in `sealed` or `launching` state. Read-only, no lock. */
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
    if (meta && (meta.state === 'sealed' || meta.state === 'launching')) {
      active.push(meta)
    }
  }
  return active
}
