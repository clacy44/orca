// S10-22a WAVE 2 (Wave 2 contract "Startup scan (A10)"; D-R215 §Protocol step 9): NEVER launches
// anything. Walks every chair's active (sealed/launching/confirming) successions once at runtime
// start and resolves each to a terminal state:
//   sealed              -> aborted (reason startup) — no successor pane was ever launched for it.
//   launching/confirming -> [G1-10z M4 repair, chair ruling] if the chair's agents row ALREADY
//                sits on the successor pane (a takeover committed before the crash/restart, only
//                the record/manifest write never landed) -> mark confirmed (record + manifest,
//                under the per-chair lock); otherwise -> close the successor pane and abort. Never
//                the old startup_unconfirmed fallback, which left an orphan record that could
//                never be accepted again (accept only transitions `launching`) — `orca chairs
//                restore` handles the rest once the record is terminal.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import {
  chairLockKey,
  read,
  transition,
  transitionLocked,
  withPaneLock,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { SuccessionMeta, SuccessionState } from './chair-succession-types'
import { parseChairsManifest, type ChairsManifest } from './chairs-manifest'
import { defaultChairsManifestPath } from './chair-succession-manifest-entry'
import { writeFileAtomic, pathExists } from '../rpc/methods/chairs-restore'
import { purgeSuccessionsForChair } from './chair-succession-purge'

// Narrowed to exactly the two runtime primitives this scan needs (same pattern
// chairs-restore-execute.ts's `ChairsRestoreExecutorDeps` uses) — a real `OrcaRuntimeService`
// satisfies this trivially; tests supply a narrow fake instead of the whole class.
export type SuccessionStartupScanRuntime = Pick<OrcaRuntimeService, 'closeTerminal'>

export type SuccessionStartupScanDb = Pick<OrchestrationDb, 'getAgentByName'>

export type SuccessionStartupScanDeps = {
  runtime: SuccessionStartupScanRuntime
  db: SuccessionStartupScanDb
  orcaHome: string
  /** Defaults to `~/.orca/chairs.json` (`defaultChairsManifestPath()`) — overridable for tests. */
  manifestPath?: string
  /** Defaults to 'local' — D-R215's own residual (3): slice 1 is single-host local chairs. */
  hostId?: string
}

function storeDepsFor(deps: SuccessionStartupScanDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

async function closeSuccessorPaneBestEffort(
  runtime: SuccessionStartupScanRuntime,
  meta: SuccessionMeta
): Promise<void> {
  if (!meta.successor.terminalHandle) {
    return
  }
  try {
    await runtime.closeTerminal(meta.successor.terminalHandle)
  } catch {
    // best-effort — the pane may already be gone.
  }
}

/** [G1 repair L5] Mirrors chair-succession-accept.ts's `writeManifestLastSessionId` (not itself
 * exported — this dispatch is scoped away from that file). Duplicated here rather than imported,
 * flagged: a follow-up should hoist one shared helper once both worker locks release. Same A7
 * lock key (`chairs-manifest:<host>`), same "no manifest / bad JSON / unknown chair / no-op
 * write" tolerances — a startup scan must never throw for a manifest quirk it did not cause. */
async function confirmManifestEntryAtStartup(
  manifestPath: string | undefined,
  hostId: string,
  chair: string,
  sessionId: string | undefined
): Promise<void> {
  if (!sessionId) {
    return
  }
  const path = manifestPath ?? defaultChairsManifestPath()
  await withPaneLock(`chairs-manifest:${hostId}`, async () => {
    if (!(await pathExists(path))) {
      return
    }
    let raw: string
    try {
      const { readFile } = await import('node:fs/promises')
      raw = await readFile(path, 'utf8')
    } catch {
      return
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseChairsManifest(parsedJson)
    if (!parsed.ok) {
      return
    }
    const manifest: ChairsManifest = parsed.manifest
    const entry = manifest.chairs.find((c) => c.name === chair)
    if (!entry || entry.lastSessionId === sessionId) {
      return
    }
    entry.lastSessionId = sessionId
    await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
  })
}

/** [G1 repair M4, chair ruling] Confirms a `launching`/`confirming` record whose chair identity
 * already sits on the successor pane — under the per-chair lock, re-reading the record inside it
 * (the same shape B3's confirming-transition takes) so a concurrent writer is never raced. */
async function confirmAlreadyTakenOver(
  deps: SuccessionStartupScanDeps,
  meta: SuccessionMeta
): Promise<void> {
  const storeDeps = storeDepsFor(deps)
  await withPaneLock(chairLockKey(meta.chair), async () => {
    const current = await read(storeDeps, meta.chair, meta.id)
    if (!current) {
      return
    }
    let state: SuccessionState = current.state
    let record = current
    if (state === 'launching') {
      record = await transitionLocked(storeDeps, meta.chair, meta.id, 'confirming')
      state = record.state
    }
    if (state === 'confirming') {
      record = await transitionLocked(storeDeps, meta.chair, meta.id, 'confirmed', {
        retiredHandle: meta.incumbent.terminalHandle
      })
    }
  })
  await confirmManifestEntryAtStartup(
    deps.manifestPath,
    deps.hostId ?? 'local',
    meta.chair,
    meta.successor.sessionId
  )
  // [G1-10z Q8 repair] "after every confirm" — this scan's own confirm path is one such site;
  // the RPC accept path's confirm (chair-succession-accept.ts) is the other, not wired here (see
  // chair-succession-purge.ts's header).
  await purgeSuccessionsForChair(storeDeps, meta.chair)
}

async function scanOneSuccession(
  deps: SuccessionStartupScanDeps,
  meta: SuccessionMeta
): Promise<void> {
  const storeDeps = storeDepsFor(deps)
  if (meta.state === 'sealed') {
    await transition(storeDeps, meta.chair, meta.id, 'aborted', { abortReason: 'startup' })
    return
  }
  // launching or confirming
  const successorPaneKey = meta.successor.paneKey
  const chairAgent = deps.db.getAgentByName(deps.hostId ?? 'local', meta.chair)
  const successorIsChair =
    successorPaneKey !== undefined &&
    chairAgent !== undefined &&
    chairAgent.pane_key === successorPaneKey
  if (successorIsChair) {
    await confirmAlreadyTakenOver(deps, meta)
    return
  }
  await closeSuccessorPaneBestEffort(deps.runtime, meta)
  await transition(storeDeps, meta.chair, meta.id, 'aborted', { abortReason: 'startup' })
}

async function listStrandedMeta(
  deps: SuccessionStartupScanDeps,
  chair: string
): Promise<SuccessionMeta[]> {
  const storeDeps = storeDepsFor(deps)
  const dir = join(deps.orcaHome, 'chairs', chair, 'successions')
  let ids: string[]
  try {
    ids = await readdir(dir)
  } catch {
    return []
  }
  const metas: SuccessionMeta[] = []
  for (const id of ids) {
    const meta = await read(storeDeps, chair, id)
    if (
      meta &&
      (meta.state === 'sealed' || meta.state === 'launching' || meta.state === 'confirming')
    ) {
      metas.push(meta)
    }
  }
  return metas
}

/** Called once from runtime startup, BEFORE the ordinary pane restore sweep (D-R215 step 9's
 * order) — never launches anything; every branch above only transitions state and, at most,
 * closes an existing pane, or completes a takeover that already committed before a crash. A
 * missing `<orcaHome>/chairs/` directory (no chair has ever succeeded) is a silent no-op. */
export async function scanSuccessionsAtStartup(deps: SuccessionStartupScanDeps): Promise<void> {
  let chairs: string[]
  try {
    chairs = await readdir(join(deps.orcaHome, 'chairs'))
  } catch {
    return
  }
  for (const chair of chairs) {
    const stranded = await listStrandedMeta(deps, chair)
    for (const meta of stranded) {
      await scanOneSuccession(deps, meta)
    }
  }
}
