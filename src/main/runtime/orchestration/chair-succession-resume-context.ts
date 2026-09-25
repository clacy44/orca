// S10-22a WAVE 2 (Wave 2 contract: `orchestration.chairs.resumeContext`): looks a sealed
// resume-context.md up either by `successionId` or — hook mode — by the CALLER's own pane.
//
// G1 repair M3 (chair ruling D-R219): the "served" set is REMOVED — `chair-succession-accept.ts`'s
// `acceptSuccession` now ALWAYS returns the full resume context, unconditionally, so nothing in
// this file needs to track whether the hook already won the race.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SuccessionMeta } from './chair-succession-types'
import { read, type ChairSuccessionStoreDeps } from './chair-succession-store'
import type { ChairSuccessionDeps } from './chair-succession-execute'

const RESUME_CONTEXT_HOOK_WINDOW_MS = 10 * 60 * 1000

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

export async function findSuccessionById(
  deps: ChairSuccessionDeps,
  successionId: string
): Promise<SuccessionMeta | null> {
  let chairs: string[]
  try {
    chairs = await readdir(join(deps.orcaHome, 'chairs'))
  } catch {
    return null
  }
  for (const chair of chairs) {
    const meta = await read(storeDepsFor(deps), chair, successionId)
    if (meta) {
      return meta
    }
  }
  return null
}

/** Hook mode's lookup: the record whose SUCCESSOR pane is the caller's own, in state `launching`
 * or `confirmed`, sealed within the last 10 minutes (D-R215 §Protocol step 5 "gated on the
 * succession record: successor pane, state launching, source=startup"; `confirmed` added so a
 * hook firing just after the accept-driven confirm still serves). */
export async function findSuccessionForSuccessorPane(
  deps: ChairSuccessionDeps,
  paneKey: string
): Promise<SuccessionMeta | null> {
  let chairs: string[]
  try {
    chairs = await readdir(join(deps.orcaHome, 'chairs'))
  } catch {
    return null
  }
  const now = Date.now()
  for (const chair of chairs) {
    let ids: string[]
    try {
      ids = await readdir(join(deps.orcaHome, 'chairs', chair, 'successions'))
    } catch {
      continue
    }
    for (const id of ids) {
      const meta = await read(storeDepsFor(deps), chair, id)
      if (!meta) {
        continue
      }
      if (meta.successor.paneKey !== paneKey) {
        continue
      }
      if (meta.state !== 'launching' && meta.state !== 'confirming' && meta.state !== 'confirmed') {
        continue
      }
      if (now - Date.parse(meta.createdAt) > RESUME_CONTEXT_HOOK_WINDOW_MS) {
        continue
      }
      return meta
    }
  }
  return null
}

export async function readResumeContextText(
  deps: ChairSuccessionDeps,
  meta: SuccessionMeta
): Promise<string> {
  return readFile(
    join(deps.orcaHome, 'chairs', meta.chair, 'successions', meta.id, 'resume-context.md'),
    'utf8'
  )
}
