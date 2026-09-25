// S10-22a G1 repair round (B3/B5/L3): split out of chair-succession-accept.ts (line ratchet) —
// the confirming-transition, entirely under `chairLockKey(hold.chair)`, released BEFORE
// `acceptSuccession` closes the incumbent. `chair-succession-hold.ts`'s `runAbortTail` takes the
// SAME lock and re-reads state inside it, so the two can never both act on one record.
import {
  chairLockKey,
  read,
  transitionLocked,
  withPaneLock,
  SuccessionBadTransitionError,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import type { HoldRecord } from './chair-succession-hold'

const ACCEPT_LAUNCHING_MAX_AGE_MS = 150_000

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

export async function enterConfirming(
  deps: ChairSuccessionDeps,
  hold: HoldRecord,
  successionId: string,
  callerPaneKey: string
): Promise<Awaited<ReturnType<typeof transitionLocked>>> {
  try {
    return await withPaneLock(chairLockKey(hold.chair), async () => {
      const current = await read(storeDepsFor(deps), hold.chair, successionId)
      if (!current) {
        throw new OrchestrationError('succession_unknown', `No succession ${successionId}.`)
      }
      if (current.successor.paneKey !== callerPaneKey) {
        throw new OrchestrationError(
          'succession_wrong_pane',
          'This succession was not launched onto the calling pane.'
        )
      }
      if (Date.now() - Date.parse(current.createdAt) > ACCEPT_LAUNCHING_MAX_AGE_MS) {
        throw new OrchestrationError('succession_expired', `Succession ${successionId} expired.`)
      }
      // G1 repair L3: the incumbent must still hold the Run seal bound to — otherwise the
      // takeover would rebind a Run the incumbent no longer coordinates.
      if (hold.runId) {
        const currentRun = deps.db.getCurrentRunForPane(hold.incumbent.paneKey)
        if (!currentRun || currentRun.id !== hold.runId) {
          throw new OrchestrationError(
            'succession_run_moved',
            `Run ${hold.runId} is no longer bound to the incumbent's pane.`
          )
        }
      }
      return transitionLocked(storeDepsFor(deps), hold.chair, successionId, 'confirming')
    })
  } catch (err) {
    if (err instanceof SuccessionBadTransitionError) {
      throw new OrchestrationError(
        'succession_not_launching',
        `Succession ${successionId} is not launching.`
      )
    }
    throw err
  }
}
