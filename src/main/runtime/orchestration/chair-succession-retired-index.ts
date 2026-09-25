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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type RetiredHandleEntry = { handle: string; succession: string; at: string }

let index = new Map<string, string>() // handle -> chair name

function chairsRoot(orcaHome: string): string {
  return join(orcaHome, 'chairs')
}

/** Full rescan of every chair's `retired-handles.json` under `orcaHome`, replacing the whole
 * in-memory index. Synchronous by design (see header). A missing `chairs/` root, or a missing or
 * unreadable `retired-handles.json` for one chair, is treated as "no retired handles for that
 * chair" — never thrown, since a stale/absent file must not block runtime startup or a send. */
export function refreshRetiredHandlesIndexSync(orcaHome: string): void {
  const next = new Map<string, string>()
  let chairs: string[]
  try {
    chairs = readdirSync(chairsRoot(orcaHome))
  } catch {
    index = next
    return
  }
  for (const chair of chairs) {
    const path = join(chairsRoot(orcaHome), chair, 'retired-handles.json')
    try {
      const entries = JSON.parse(readFileSync(path, 'utf8')) as RetiredHandleEntry[]
      for (const entry of entries) {
        next.set(entry.handle, chair)
      }
    } catch {
      // No retired-handles.json yet, or unreadable — this chair contributes nothing.
    }
  }
  index = next
}

/** Same rescan, named for the "at runtime start" call site (Wave 2 contract: "the retired list
 * is loaded at runtime start and refreshed on append") — there is no incremental path, so start
 * and refresh are the same operation. */
export const loadRetiredHandlesIndexSync = refreshRetiredHandlesIndexSync

/** The chair whose retired handle `handle` was, or `undefined` — O(1), read-only, no IO. */
export function retiredHandleChair(handle: string): string | undefined {
  return index.get(handle)
}

/** Test-only reset — the module-level cache otherwise persists across fixtures in the same
 * process. */
export function _resetRetiredHandlesIndexForTest(): void {
  index = new Map()
}
