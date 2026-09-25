// S10-22a: leaf module for reading one succession's meta.json — no dependency on
// chair-succession-store.ts, so store.ts and chair-succession-store-reads.ts can both import from
// here without forming an import cycle.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { successionDir, type ChairSuccessionStoreDeps } from './chair-succession-paths'
import type { SuccessionMeta } from './chair-succession-types'

/** Read-only; no lock (a snapshot read racing a concurrent writer only ever sees a fully-written
 * meta.json, since every write is atomic tmp+rename). */
export async function readSuccessionMeta(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string
): Promise<SuccessionMeta | null> {
  try {
    const raw = await readFile(join(successionDir(deps, chair, id), 'meta.json'), 'utf8')
    return JSON.parse(raw) as SuccessionMeta
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}
