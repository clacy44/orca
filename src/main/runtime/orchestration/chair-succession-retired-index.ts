// S10-22a WAVE 2 (Wave 2 contract "Mail (A3)"): an in-memory retired-handle -> chair index.
// `insertGatedMessage` (message-gate-writer.ts) is itself synchronous — the single write choke
// for every peer-facing send — so this index is a synchronous, pre-populated cache rather than
// an IO call on the hot path. Populated once at runtime start (`refreshRetiredHandlesIndexSync`,
// called from the same startup site `scanSuccessionsAtStartup` is, per the Wave 2 contract) and
// meant to be refreshed after every `chair-succession-store.ts` `appendRetiredHandle` — this
// dispatch could not wire that second call site: `chair-succession-accept.ts` (the only current
// caller of `appendRetiredHandle`) is under another worker's edit lock for this dispatch. Exported
// here so that worker (or a follow-up) can add one `refreshRetiredHandlesIndexSync(deps.orcaHome)`
// call right after its own `appendRetiredHandle` — flagged, not silently skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

type RetiredHandleEntry = { handle: string; succession: string; at: string }

// [G1-10z Q8 repair] Every lookup used to scan every chair's meta.json — this was already a
// flat handle->chair Map for O(1) READS, but the REFRESH itself re-read every chair's
// retired-handles.json unconditionally (readFileSync per chair, per refresh — Q8's own "index
// rebuilt by sync readFileSync per accept" complaint). Incremental now: a chair whose
// retired-handles.json mtime is unchanged since the last refresh is skipped entirely.
let index = new Map<string, string>() // handle -> chair name
let chairHandles = new Map<string, string[]>() // chair -> its own handles (to remove stale ones)
let chairMtimeMs = new Map<string, number>() // chair -> retired-handles.json mtimeMs last read

function chairsRoot(orcaHome: string): string {
  return join(orcaHome, 'chairs')
}

function readChairEntries(orcaHome: string, chair: string): RetiredHandleEntry[] {
  const path = join(chairsRoot(orcaHome), chair, 'retired-handles.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RetiredHandleEntry[]
  } catch {
    // No retired-handles.json yet, or unreadable — this chair contributes nothing.
    return []
  }
}

function removeChairFromIndex(chair: string): void {
  for (const handle of chairHandles.get(chair) ?? []) {
    if (index.get(handle) === chair) {
      index.delete(handle)
    }
  }
  chairHandles.delete(chair)
  chairMtimeMs.delete(chair)
}

function statMtimeMs(orcaHome: string, chair: string): number | undefined {
  try {
    return statSync(join(chairsRoot(orcaHome), chair, 'retired-handles.json')).mtimeMs
  } catch {
    return undefined
  }
}

/** Incremental rescan: a chair whose `retired-handles.json` mtime is unchanged since the last
 * call is skipped (its existing entries stay as-is); a chair no longer present under
 * `orcaHome/chairs/` has its entries dropped. Synchronous by design (see header). A missing
 * `chairs/` root clears the whole index (never thrown — a stale/absent file must not block
 * runtime startup or a send). */
export function refreshRetiredHandlesIndexSync(orcaHome: string): void {
  let chairs: string[]
  try {
    chairs = readdirSync(chairsRoot(orcaHome))
  } catch {
    index = new Map()
    chairHandles = new Map()
    chairMtimeMs = new Map()
    return
  }
  const seen = new Set(chairs)
  // Deleting the CURRENT key mid-iteration is well-defined for Map (spec-guaranteed iteration
  // order, no key revisited/skipped) — no array copy needed.
  for (const chair of chairMtimeMs.keys()) {
    if (!seen.has(chair)) {
      removeChairFromIndex(chair)
    }
  }
  for (const chair of chairs) {
    const mtimeMs = statMtimeMs(orcaHome, chair)
    if (mtimeMs === undefined) {
      // No retired-handles.json (or unreadable) for this chair right now — drop any stale
      // entries it previously contributed rather than leaving them indexed forever.
      if (chairMtimeMs.has(chair)) {
        removeChairFromIndex(chair)
      }
      continue
    }
    if (chairMtimeMs.get(chair) === mtimeMs) {
      continue // unchanged since the last refresh — skip the read entirely.
    }
    const entries = readChairEntries(orcaHome, chair)
    for (const handle of chairHandles.get(chair) ?? []) {
      if (index.get(handle) === chair) {
        index.delete(handle)
      }
    }
    const handles: string[] = []
    for (const entry of entries) {
      index.set(entry.handle, chair)
      handles.push(entry.handle)
    }
    chairHandles.set(chair, handles)
    chairMtimeMs.set(chair, mtimeMs)
  }
}

/** Same rescan, named for the "at runtime start" call site (Wave 2 contract: "the retired list
 * is loaded at runtime start and refreshed on append") — start and refresh are the same
 * incremental operation; "start" just means every chair's mtime is unseen yet, so the first call
 * reads every chair once. */
export const loadRetiredHandlesIndexSync = refreshRetiredHandlesIndexSync

/** The chair whose retired handle `handle` was, or `undefined` — O(1), read-only, no IO. */
export function retiredHandleChair(handle: string): string | undefined {
  return index.get(handle)
}

/** Test-only reset — the module-level cache otherwise persists across fixtures in the same
 * process. */
export function _resetRetiredHandlesIndexForTest(): void {
  index = new Map()
  chairHandles = new Map()
  chairMtimeMs = new Map()
}
