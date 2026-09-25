// [S10-22a Wave 2 contract, "Startup scan (A10)"; D-R215 §Protocol step 9; G1-10z B4 repair]
// Extracted to its own module (not left inline in index.ts) so both the desktop path
// (`runStartupRestoreSweepBody`) and the SERVE path (`runStartupRestoreSweep`) call the exact
// same function — before this repair, `orca serve` never ran the succession scan or loaded the
// retired-handle index at all (only the desktop-only body did), so on serve a stuck
// sealed/launching record wedged the chair's `succeed` call forever (`succession_in_flight`
// never clears) and a retired handle's mail was never rewritten. Runs BEFORE the ordinary pane
// restore sweep (D-R215 step 9's own order: successions resolved first, then the sweep, then
// `orca chairs restore`) — never launches anything itself (see chair-succession-startup-scan.ts).
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { scanSuccessionsAtStartup } from '../runtime/orchestration/chair-succession-startup-scan'
import { loadRetiredHandlesIndexSync } from '../runtime/orchestration/chair-succession-retired-index'
import { purgeSuccessionsAtStartup } from '../runtime/orchestration/chair-succession-purge'

// [G1-10z attempt-2 N10 repair] `cancelMessageWaiters` added — the startup scan's own confirm
// tail now rebinds the Run (chair-succession-startup-scan.ts's `confirmAlreadyTakenOver`), the
// same step accept.ts's confirm tail takes.
export type ChairSuccessionStartupHookRuntime = Pick<
  OrcaRuntimeService,
  'closeTerminal' | 'cancelMessageWaiters'
> & {
  getOrchestrationDb: OrcaRuntimeService['getOrchestrationDb']
}

/** Never throws — a scan/index failure must not block the pane restore sweep that follows it on
 * either path. Logs and swallows, same shape the sweep itself already uses. */
export async function runChairSuccessionStartupHook(
  runtimeService: ChairSuccessionStartupHookRuntime,
  orcaHomeOverride?: string
): Promise<void> {
  try {
    const orcaHome = orcaHomeOverride ?? join(homedir(), '.orca')
    loadRetiredHandlesIndexSync(orcaHome)
    await scanSuccessionsAtStartup({
      runtime: runtimeService,
      db: runtimeService.getOrchestrationDb(),
      orcaHome
    })
    // [G1-10z Q8 repair] Runs after the scan resolves every stranded record — a dir the scan just
    // transitioned to aborted/confirmed is eligible the very next purge, not one boot later.
    await purgeSuccessionsAtStartup({ orcaHome })
  } catch (error) {
    console.error('[chair-succession] HARNESS: the startup succession scan threw:', error)
  }
}
