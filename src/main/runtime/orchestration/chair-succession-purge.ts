// [G1-10z Q8 repair; G1-10z attempt-2 N15 header fix] `<orcaHome>/chairs/<chair>/successions/
// <id>/` was never deleted (confirmed or aborted, up to 32+48 KiB + an embedded charter each) and
// `retired-handles.json` was append-only forever — unbounded on-disk growth over a chair's
// lifetime. Run from the startup hook (chair-succession-startup-hook.ts) and, per the contract,
// after every confirm — wired at both post-confirm call sites: `chair-succession-accept.ts`'s
// confirm tail (:320) and this scan's own startup confirm (chair-succession-startup-scan.ts's
// `confirmAlreadyTakenOver`).
import { readdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chairLockKey,
  chairRoot,
  retiredHandlesPath,
  withPaneLock,
  type ChairSuccessionStoreDeps,
  type RetiredHandleEntry
} from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'

export type PurgeSummary = {
  successionDirsDeleted: number
  retiredHandlesTrimmed: number
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const KEEP_NEWEST_SUCCESSIONS_PER_CHAIR = 5
const KEEP_NEWEST_RETIRED_HANDLES = 50

function successionsRoot(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(chairRoot(deps, chair), 'successions')
}

async function readMetaBestEffort(dir: string): Promise<SuccessionMeta | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SuccessionMeta
  } catch {
    return null
  }
}

/** Deletes `confirmed`/`aborted` succession directories for `chair` older than 7 days, always
 * keeping the newest `KEEP_NEWEST_SUCCESSIONS_PER_CHAIR` regardless of age (a safety margin — the
 * newest terminal record is often still useful for a manual post-mortem). `sealed`/`launching`/
 * `confirming` records are NEVER touched here (an active succession is never purge-eligible). */
async function purgeSuccessionDirsForChair(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  now: number
): Promise<number> {
  const root = successionsRoot(deps, chair)
  let ids: string[]
  try {
    ids = await readdir(root)
  } catch {
    return 0
  }
  const terminal: { id: string; dir: string; updatedAtMs: number }[] = []
  for (const id of ids) {
    const dir = join(root, id)
    const meta = await readMetaBestEffort(dir)
    if (!meta || (meta.state !== 'confirmed' && meta.state !== 'aborted')) {
      continue
    }
    const updatedAtMs = Date.parse(meta.updatedAt)
    terminal.push({ id, dir, updatedAtMs: Number.isNaN(updatedAtMs) ? 0 : updatedAtMs })
  }
  // Newest first — the newest KEEP_NEWEST_SUCCESSIONS_PER_CHAIR are exempt from age eligibility.
  terminal.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  let deleted = 0
  for (let i = KEEP_NEWEST_SUCCESSIONS_PER_CHAIR; i < terminal.length; i += 1) {
    const entry = terminal[i]
    if (now - entry.updatedAtMs < SEVEN_DAYS_MS) {
      continue
    }
    try {
      await rm(entry.dir, { recursive: true, force: true })
      deleted += 1
    } catch {
      // best-effort — a concurrent purge/read may have already removed it.
    }
  }
  return deleted
}

/** Caps `retired-handles.json` at the newest `KEEP_NEWEST_RETIRED_HANDLES` entries (append order
 * — oldest entries are dropped first) under the same per-chair lock every writer uses. A no-op
 * (never even opens the file) when the file is missing or already at/under the cap. */
async function trimRetiredHandlesForChair(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<number> {
  return withPaneLock(chairLockKey(chair), async () => {
    const path = retiredHandlesPath(deps, chair)
    let entries: RetiredHandleEntry[]
    try {
      entries = JSON.parse(await readFile(path, 'utf8')) as RetiredHandleEntry[]
    } catch {
      return 0
    }
    if (entries.length <= KEEP_NEWEST_RETIRED_HANDLES) {
      return 0
    }
    const trimmedCount = entries.length - KEEP_NEWEST_RETIRED_HANDLES
    const kept = entries.slice(entries.length - KEEP_NEWEST_RETIRED_HANDLES)
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(kept, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
    return trimmedCount
  })
}

/** Purges every chair under `<orcaHome>/chairs/` — best-effort, never throws (a purge failure
 * must never block startup or a confirm). Missing `<orcaHome>/chairs/` is a silent no-op. */
export async function purgeSuccessionsAtStartup(
  deps: ChairSuccessionStoreDeps
): Promise<PurgeSummary> {
  const summary: PurgeSummary = { successionDirsDeleted: 0, retiredHandlesTrimmed: 0 }
  let chairs: string[]
  try {
    chairs = await readdir(join(deps.orcaHome, 'chairs'))
  } catch {
    return summary
  }
  const now = Date.now()
  for (const chair of chairs) {
    try {
      summary.successionDirsDeleted += await purgeSuccessionDirsForChair(deps, chair, now)
      summary.retiredHandlesTrimmed += await trimRetiredHandlesForChair(deps, chair)
    } catch {
      // best-effort per chair — one chair's I/O fault must not stop the rest.
    }
  }
  return summary
}

/** Purges ONE chair — the shape a post-confirm call site needs: a confirm just finished for
 * exactly this chair, no reason to walk every other one. Both wired call sites are named in the
 * file header. */
export async function purgeSuccessionsForChair(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<PurgeSummary> {
  const now = Date.now()
  return {
    successionDirsDeleted: await purgeSuccessionDirsForChair(deps, chair, now),
    retiredHandlesTrimmed: await trimRetiredHandlesForChair(deps, chair)
  }
}
