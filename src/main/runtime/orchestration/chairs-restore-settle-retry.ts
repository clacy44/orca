// Rebind/launch handling for `executeChairsRestorePlan`, split out so that file stays under its
// line budget. A chair whose restore is refused as `same_generation_settling` (the incumbent-death
// observation window, REBIND_SETTLE_MS) is DEFERRED on the first pass, and every deferred chair is
// retried exactly once after a single wait for the whole run — so the user never has to re-run the
// command, and the wall time stays inside the CLI's 60 s timeout. Any other refusal is never
// retried.
import type { ChairsManifestEntry } from './chairs-manifest'
import type {
  ChairsRestoreExecutorDeps,
  ChairsRestoreResultRow,
  ChairsRestoreVerificationRow
} from './chairs-restore-execute'
import type { ChairsRestorePlanAction } from './chairs-restore-plan'
import { REBIND_SETTLE_MS } from '../incumbent-death'

export type RestoreAction = Extract<ChairsRestorePlanAction, { kind: 'rebind' | 'launch' }>

export type RestoreActionResult = {
  row: ChairsRestoreResultRow
  /** The row is not ok (drives the non-zero exit). */
  failed: boolean
  /** The restore itself succeeded (drives the post-run publish and materialize). */
  succeeded: boolean
  /** The entry's `lastSessionId` write-back changed. */
  changed: boolean
}

export type DeferredRestoreAction = {
  slot: number
  action: RestoreAction
  entry: ChairsManifestEntry
}

export type BuildVerificationRow = (
  entry: ChairsManifestEntry,
  kind: 'skip_live' | 'rebind' | 'launch',
  paneKey: string,
  deps: ChairsRestoreExecutorDeps
) => Promise<ChairsRestoreVerificationRow>

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** rebind | launch: same call — requestChairRestore's own DEC-3 predicate distinguishes
 * adoption from an unheld restore internally; the executor need not branch on it. With
 * `allowDefer`, a `same_generation_settling` refusal returns null (no row yet) instead of an
 * error row. */
export async function runRestoreAction(
  action: RestoreAction,
  entry: ChairsManifestEntry,
  allowDefer: false,
  deps: ChairsRestoreExecutorDeps,
  buildRow: BuildVerificationRow
): Promise<RestoreActionResult>
export async function runRestoreAction(
  action: RestoreAction,
  entry: ChairsManifestEntry,
  allowDefer: boolean,
  deps: ChairsRestoreExecutorDeps,
  buildRow: BuildVerificationRow
): Promise<RestoreActionResult | null>
export async function runRestoreAction(
  action: RestoreAction,
  entry: ChairsManifestEntry,
  allowDefer: boolean,
  deps: ChairsRestoreExecutorDeps,
  buildRow: BuildVerificationRow
): Promise<RestoreActionResult | null> {
  const outcome = await deps.requestChairRestore({
    worktreeSelector: entry.worktree,
    sessionId: action.sessionId,
    displayName: entry.name,
    role: entry.role,
    model: entry.model,
    effort: entry.effort,
    launchArgs: entry.launchArgs
  })
  if (!outcome.ok) {
    if (allowDefer && outcome.reason === 'same_generation_settling') {
      return null
    }
    return {
      row: {
        name: action.name,
        kind: 'error',
        reason: outcome.reason,
        ok: false,
        ...(outcome.detail ? { detail: outcome.detail } : {})
      },
      failed: true,
      succeeded: false,
      changed: false
    }
  }
  const row = await buildRow(entry, action.kind, outcome.paneKey, deps)
  // [S10-21d b3b, D-R165 M1 fix] The RECORDED id (what the admission actually wrote), never the
  // requested `action.sessionId` blindly — a mismatch there is exactly what `row.ok` catches,
  // and pinning the requested id anyway would make the write-back lie about what happened.
  const nextSessionId = row.recorded ?? action.sessionId
  let changed = false
  if (entry.lastSessionId !== nextSessionId) {
    entry.lastSessionId = nextSessionId
    changed = true
  }
  return { row, failed: !row.ok, succeeded: true, changed }
}

/** One wait for the whole run (never per chair), then each deferred action once more with
 * deferral off. Results come back with their original slot so the caller keeps plan order. */
export async function retryDeferredRestoreActions(
  deferred: readonly DeferredRestoreAction[],
  deps: ChairsRestoreExecutorDeps,
  buildRow: BuildVerificationRow
): Promise<{ slot: number; result: RestoreActionResult }[]> {
  if (deferred.length === 0) {
    return []
  }
  await (deps.sleep ?? defaultSleep)(REBIND_SETTLE_MS + 1_000)
  const retried: { slot: number; result: RestoreActionResult }[] = []
  for (const { slot, action, entry } of deferred) {
    retried.push({ slot, result: await runRestoreAction(action, entry, false, deps, buildRow) })
  }
  return retried
}

/** After at least one restore succeeded: push fresh live-session marks to the renderer and queue
 * the restored panes for a visible tab. Neither may fail the restore, so this can neither throw
 * nor reject: each dep runs inside a promise callback, which also turns a SYNCHRONOUS throw from
 * a dep into a settled rejection. */
export async function publishAfterRestore(deps: ChairsRestoreExecutorDeps): Promise<void> {
  await Promise.allSettled([
    Promise.resolve().then(() => deps.publishLiveAgentSessionMarks?.()),
    Promise.resolve().then(() => deps.materializeRestoredPanes?.())
  ])
}
