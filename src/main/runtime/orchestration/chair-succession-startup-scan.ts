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
import { appendRetiredHandle } from './chair-succession-retired-handles'
import { refreshRetiredHandlesIndexSync } from './chair-succession-retired-index'
import { writeManifestLastSessionId } from './chair-succession-manifest-session-write'
import type { SuccessionMeta, SuccessionState } from './chair-succession-types'
import { purgeSuccessionsForChair } from './chair-succession-purge'

// Narrowed to exactly the runtime primitives this scan needs (same pattern
// chairs-restore-execute.ts's `ChairsRestoreExecutorDeps` uses) — a real `OrcaRuntimeService`
// satisfies this trivially; tests supply a narrow fake instead of the whole class.
export type SuccessionStartupScanRuntime = Pick<
  OrcaRuntimeService,
  'closeTerminal' | 'cancelMessageWaiters'
>

export type SuccessionStartupScanDb = Pick<OrchestrationDb, 'getAgentByName' | 'bindRun'>

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

/** [G1-10z attempt-2 N10 repair] Confirms a `launching`/`confirming` record whose chair identity
 * already sits on the successor pane — under the per-chair lock, re-reading the record inside it
 * (the same shape B3's confirming-transition takes) so a concurrent writer is never raced. Runs
 * the REST of accept's confirm tail too, idempotently — previously this only confirmed the
 * record and the manifest: the Run stayed bound to the dead incumbent pane, and the retired
 * handle was never appended to retired-handles.json (only `meta.retiredHandle` was set, by the
 * `confirmed` transition above). Each step is best-effort (swallowed, never thrown past this
 * scan — a crash-recovery path must never itself crash on a stale Run or a bad manifest), same
 * as `closeSuccessorPaneBestEffort` above. [G1-10z attempt-2 N15] Dedupes onto the now-exported
 * `writeManifestLastSessionId` (chair-succession-manifest-session-write.ts) instead of a second
 * hand-written copy of accept's manifest write. */
async function confirmAlreadyTakenOver(
  deps: SuccessionStartupScanDeps,
  meta: SuccessionMeta
): Promise<void> {
  const storeDeps = storeDepsFor(deps)
  const hostId = deps.hostId ?? 'local'
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

  // Rebind the Run to the successor pane — without this, the Run stays bound to the dead
  // incumbent (N10). The successor's own agent row is the chair by construction (the caller's
  // `successorIsChair` check), so it carries the coordinator handle/pane key to bind to.
  const runId = meta.runId
  if (runId) {
    const chairAgent = deps.db.getAgentByName(hostId, meta.chair)
    const coordinatorHandle = chairAgent?.terminal_handle ?? meta.successor.terminalHandle
    const coordinatorPaneKey = chairAgent?.pane_key ?? meta.successor.paneKey
    if (coordinatorHandle && coordinatorPaneKey) {
      try {
        deps.db.bindRun({ runId, coordinatorHandle, coordinatorPaneKey })
        deps.runtime.cancelMessageWaiters(`run:${runId}`)
      } catch {
        // best-effort — a startup confirm must never throw for a stale/adopted Run.
      }
    }
  }

  try {
    await appendRetiredHandle(storeDeps, meta.chair, {
      handle: meta.incumbent.terminalHandle,
      succession: meta.id,
      at: new Date().toISOString()
    })
    refreshRetiredHandlesIndexSync(deps.orcaHome)
  } catch {
    // best-effort — see above.
  }

  await writeManifestLastSessionId(
    deps.manifestPath,
    hostId,
    meta.chair,
    meta.successor.sessionId ?? null
  ).catch(() => {
    // best-effort — see above.
  })

  // [G1-10z Q8 repair] "after every confirm" — this scan's own confirm path is one such site;
  // the RPC accept path's confirm (chair-succession-accept.ts) is the other.
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
