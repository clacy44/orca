// S10-22a WAVE 2: the append-only `retired-handles.json` log — split out of
// chair-succession-store.ts to keep that file under the line ratchet (G1 repair round).
import { readFile } from 'node:fs/promises'
import {
  chairLockKey,
  chairRoot,
  ensureDirMode0700,
  retiredHandlesPath,
  withPaneLock,
  writeAtomic,
  type ChairSuccessionStoreDeps,
  type RetiredHandleEntry
} from './chair-succession-store'

/** WAVE 2 addition (additive only): read-only snapshot of `retired-handles.json`, append order. */
export async function listRetiredHandles(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<RetiredHandleEntry[]> {
  try {
    return JSON.parse(
      await readFile(retiredHandlesPath(deps, chair), 'utf8')
    ) as RetiredHandleEntry[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** Appends one entry to `retired-handles.json` (created on first append) under the per-chair
 * lock — append-only, never rewrites or drops a prior entry. */
export async function appendRetiredHandle(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  entry: RetiredHandleEntry
): Promise<void> {
  return withPaneLock(chairLockKey(chair), async () => {
    await ensureDirMode0700(chairRoot(deps, chair))
    const path = retiredHandlesPath(deps, chair)
    let existing: RetiredHandleEntry[] = []
    try {
      existing = JSON.parse(await readFile(path, 'utf8')) as RetiredHandleEntry[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await writeAtomic(path, JSON.stringify([...existing, entry], null, 2))
  })
}
