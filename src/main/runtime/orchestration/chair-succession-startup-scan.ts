// S10-22a WAVE 2 (Wave 2 contract "Startup scan (A10)"; D-R215 §Protocol step 9): NEVER launches
// anything. Walks every chair's active (sealed/launching) successions once at runtime start and
// resolves each to a terminal state:
//   sealed    -> aborted (reason startup) — no successor pane was ever launched for it.
//   launching -> successor pane live AND incumbent pane dead: the confirm tail SHOULD run here
//                (D-R215 step 9's "run the sweep" language) — this dispatch takes the contract's
//                own fallback instead (see RETURN): `chair-succession-accept.ts`'s
//                `acceptSuccession` is under another worker's edit lock and is not decomposed
//                into startup-safe pieces (it hard-refuses on `ACCEPT_LAUNCHING_MAX_AGE_MS`,
//                150s — every record surviving to a restart is already past that by construction,
//                so calling it unmodified here would abort every real case it exists to confirm).
//                Aborts with reason `startup_unconfirmed` and leaves the successor pane OPEN, per
//                the brief's named fallback, so the chair notices and accepts manually.
//              otherwise: aborted (reason startup), successor pane closed if one was launched.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../orca-runtime'
import { listActive, transition, type ChairSuccessionStoreDeps } from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'

// Narrowed to exactly the two runtime primitives this scan needs (same pattern
// chairs-restore-execute.ts's `ChairsRestoreExecutorDeps` uses) — a real `OrcaRuntimeService`
// satisfies this trivially; tests supply a narrow fake instead of the whole class.
export type SuccessionStartupScanRuntime = Pick<
  OrcaRuntimeService,
  'getAgentDirectoryLivenessSignals' | 'closeTerminal'
>

export type SuccessionStartupScanDeps = {
  runtime: SuccessionStartupScanRuntime
  orcaHome: string
}

function storeDepsFor(deps: SuccessionStartupScanDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

// Same predicate chairs-restore.ts's own `isPaneLiveFor` uses.
function isPaneLive(runtime: SuccessionStartupScanRuntime, paneKey: string): boolean {
  const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
  return signals.terminalHandle !== null || signals.observedLive
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

async function scanOneSuccession(
  deps: SuccessionStartupScanDeps,
  meta: SuccessionMeta
): Promise<void> {
  const storeDeps = storeDepsFor(deps)
  if (meta.state === 'sealed') {
    await transition(storeDeps, meta.chair, meta.id, 'aborted', { abortReason: 'startup' })
    return
  }
  // launching
  const successorPaneKey = meta.successor.paneKey
  const successorLive = successorPaneKey !== undefined && isPaneLive(deps.runtime, successorPaneKey)
  const incumbentLive = isPaneLive(deps.runtime, meta.incumbent.paneKey)
  if (successorLive && !incumbentLive) {
    // [see file header] Fallback taken: no reusable startup-safe confirm tail is exported by
    // chair-succession-accept.ts today — abort loudly, leave the successor pane open.
    await transition(storeDeps, meta.chair, meta.id, 'aborted', {
      abortReason: 'startup_unconfirmed'
    })
    return
  }
  await closeSuccessorPaneBestEffort(deps.runtime, meta)
  await transition(storeDeps, meta.chair, meta.id, 'aborted', { abortReason: 'startup' })
}

/** Called once from runtime startup, beside the ordinary pane restore sweep. Never launches
 * anything — every branch above only transitions state and, at most, closes an existing pane. A
 * missing `<orcaHome>/chairs/` directory (no chair has ever succeeded) is a silent no-op. */
export async function scanSuccessionsAtStartup(deps: SuccessionStartupScanDeps): Promise<void> {
  let chairs: string[]
  try {
    chairs = await readdir(join(deps.orcaHome, 'chairs'))
  } catch {
    return
  }
  for (const chair of chairs) {
    const active = await listActive(storeDepsFor(deps), chair)
    for (const meta of active) {
      await scanOneSuccession(deps, meta)
    }
  }
}
