// S10-22a: leaf module for the succession store's path/lock-key vocabulary — no dependency on
// chair-succession-store.ts, so store.ts and its siblings (retired-handles, reads) can both
// import from here without forming an import cycle.
import { join } from 'node:path'

export type ChairSuccessionStoreDeps = {
  orcaHome: string
}

export type RetiredHandleEntry = {
  handle: string
  succession: string
  at: string
}

function lockKey(chair: string): string {
  return `succession:${chair}`
}

/** G1 repair B3: the exact `withPaneLock` key `chair-succession-accept.ts` and
 * `chair-succession-hold.ts`'s `runAbortTail` both take. */
export function chairLockKey(chair: string): string {
  return lockKey(chair)
}

export function chairRoot(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(deps.orcaHome, 'chairs', chair)
}

export function successionsRoot(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(chairRoot(deps, chair), 'successions')
}

export function retiredHandlesPath(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(chairRoot(deps, chair), 'retired-handles.json')
}

export function successionDir(deps: ChairSuccessionStoreDeps, chair: string, id: string): string {
  return join(successionsRoot(deps, chair), id)
}
