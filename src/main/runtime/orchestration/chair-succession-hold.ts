// S10-22a WAVE 2 (D-R215 §Protocol steps 4/7): launch the successor, hold the incumbent's `succeed`
// call open like a parking wait, and abort (timeout or the incumbent's connection dropping first).
// The confirm ("Act") tail lives in chair-succession-accept.ts, which calls `settleHold` directly
// once it finishes — this file never itself transitions a succession to `confirmed`.
//
// G1 repair B5: `holds` is the SOURCE OF TRUTH for the incumbent's pane/handle/chair/runId once a
// hold is registered — `getHoldRecord` is what `chair-succession-accept.ts` reads instead of
// trusting `meta.json` (a same-uid writer can plant an arbitrary meta.json at a validly-shaped
// path; it cannot forge an in-process Map entry). The record is populated from `meta` at
// `holdSealRequest` registration time, i.e. straight from `sealSuccession`'s own just-created,
// fully-trusted return value — never from a later disk re-read.
import { randomBytes } from 'node:crypto'
import {
  chairLockKey,
  read,
  transition,
  transitionLocked,
  withPaneLock,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'
import type { ManifestEntryWithSuccession } from './chair-succession-manifest-entry'
import type { ChairSuccessionDeps } from './chair-succession-execute'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

/** D-R215 §Protocol step 4. `createAgentSession` (orca-runtime.ts:28469 — the primitive
 * `requestChairRestore`'s own `ensureAgentSession` call sits beside, cited in chair-restore.ts)
 * spawns a NEW background tab, first prompt exactly `orca chairs succession-accept <id>`, launch
 * prefs from the manifest. Recording the successor pane/handle/session and transitioning
 * sealed → launching happen in the SAME store write (wave 1's `LEGAL_TRANSITIONS` has no legal
 * launching → launching patch, so there is no earlier point to record a partial successor). A
 * spawn failure aborts immediately (`settleHold`) rather than waiting out the 150 s hold.
 *
 * G1 repair M8: `model`/`effort` fall back to the INCUMBENT's own last-recorded launch prefs
 * (`pref_model`/`pref_effort`) when the manifest entry sets neither — "manifest else the row"
 * (D-R215 §Protocol step 4). Slice 1 never passes a lane (A9); `sealSuccession` now refuses to
 * seal an incumbent that is not already on the host default lane, so the successor always lands
 * on the same (default) lane it would have landed on anyway. */
export async function launchSuccessor(
  deps: ChairSuccessionDeps,
  hostId: string,
  entry: ManifestEntryWithSuccession,
  meta: SuccessionMeta
): Promise<void> {
  try {
    const incumbentLaunch = deps.db.newestLaunchForPane(hostId, meta.incumbent.paneKey)
    const model = entry.model ?? incumbentLaunch?.pref_model ?? undefined
    const effort = entry.effort ?? incumbentLaunch?.pref_effort ?? undefined
    const clientOperationId = `${Date.now()}-${randomBytes(16).toString('hex')}`
    const created = await deps.runtime.createAgentSession({
      clientOperationId,
      worktree: entry.worktree,
      agent: 'claude',
      prompt: `orca chairs succession-accept ${meta.id}`,
      promptDelivery: 'auto-submit',
      ...(entry.launchArgs ? { appendAgentArgs: entry.launchArgs.join(' ') } : {}),
      ...(model || effort
        ? {
            launchPreferences: {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {})
            }
          }
        : {}),
      presentation: 'background'
    })
    const paneKey = created.terminal.paneKey
    const terminalHandle = created.terminal.handle
    if (!paneKey) {
      throw new Error('succession_launch_no_pane_key')
    }
    const sessionId = deps.db.newestLaunchForPane(hostId, paneKey)?.session_id
    await transition(storeDepsFor(deps), meta.chair, meta.id, 'launching', {
      successor: { paneKey, terminalHandle, sessionId }
    })
    // The successor pane is now the record's own — mirror it onto the hold so accept can read it
    // without a disk re-read (B5).
    const holdEntry = holds.get(meta.id)
    if (holdEntry) {
      holdEntry.record.successor = { paneKey, terminalHandle }
    }
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: paneKey,
      actorHostId: hostId,
      verb: 'succession_launch',
      outcome: 'launched',
      reasonCode: `succession=${meta.id}`.slice(0, 200)
    })
  } catch (err) {
    const reason = `launch_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
    await transition(storeDepsFor(deps), meta.chair, meta.id, 'aborted', { abortReason: reason })
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: meta.incumbent.paneKey,
      actorHostId: hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: reason
    })
    settleHold(meta.id, { ok: false, code: 'succession_aborted', successionId: meta.id, reason })
  }
}

const SEAL_HOLD_TIMEOUT_MS = 150_000

export type HoldOutcome =
  | { ok: false; code: 'succession_aborted'; successionId: string; reason: string }
  | { ok: true; confirmed: true; successionId: string }

/** G1 repair B5: the ONLY incumbent pane/handle/chair/runId `chair-succession-accept.ts` may
 * trust — never `meta.json`. `successor` is filled in once `launchSuccessor` records it (absent
 * while the launch is still in flight). */
export type HoldRecord = {
  chair: string
  incumbent: { paneKey: string; terminalHandle: string }
  runId: string | undefined
  successor?: { paneKey: string; terminalHandle: string }
}

type HoldEntry = {
  settled: boolean
  resolve: (outcome: HoldOutcome) => void
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
  signal?: AbortSignal
  record: HoldRecord
}

const holds = new Map<string, HoldEntry>()

function clearHold(id: string): void {
  const entry = holds.get(id)
  if (!entry) {
    return
  }
  clearTimeout(entry.timer)
  entry.signal?.removeEventListener('abort', entry.onAbort)
  holds.delete(id)
}

/** G1 repair B5: the trusted incumbent identity for a still-live (unsettled) hold, or `undefined`
 * once settled/never registered — `chair-succession-accept.ts`'s ONLY source for who to close and
 * which chair/Run to act on. */
export function getHoldRecord(id: string): HoldRecord | undefined {
  const entry = holds.get(id)
  return entry && !entry.settled ? entry.record : undefined
}

/** Resolves a still-open hold — a no-op once already settled or never registered. The confirm
 * path (chair-succession-accept.ts) calls this directly once its own work is done, since a
 * confirmed succession's incumbent pane is already closed by then and nothing needs an abort
 * tail run on its behalf. G1 repair Q8: always reaches `clearHold` on this path too — a rejected
 * `runAbortTail` promise (caught by its own caller, see `holdSealRequest`) never leaves an entry
 * behind that nothing will ever clear. */
export function settleHold(id: string, outcome: HoldOutcome): void {
  const entry = holds.get(id)
  if (!entry || entry.settled) {
    return
  }
  entry.settled = true
  clearHold(id)
  entry.resolve(outcome)
}

/** D-R215 §Protocol step 3 "HOLDS the request like a parking wait" / step 7 (abort). `signal` is
 * `RpcContext.signal` (rpc/core.ts:67 — "lets long-poll handlers release immediately on client
 * disconnect", the same primitive `orchestration.check --wait`'s `runtime.waitForMessage` uses,
 * orca-runtime.ts:37274-37278) — its `abort` event is the incumbent's request dropping first. */
export async function holdSealRequest(
  deps: ChairSuccessionDeps,
  hostId: string,
  meta: SuccessionMeta,
  signal: AbortSignal | undefined
): Promise<HoldOutcome> {
  return new Promise<HoldOutcome>((resolve) => {
    const finish = (reason: 'timeout' | 'incumbent_dropped'): void => {
      const entry = holds.get(meta.id)
      if (!entry || entry.settled) {
        return
      }
      void runAbortTail(deps, hostId, meta.chair, meta.id, reason)
        .catch(
          // G1 repair Q8: a rejected abort tail (I/O error etc.) must still settle the hold and
          // clear the map entry, never leak it — audited so the failure is visible, not silent.
          (err): HoldOutcome => {
            deps.db.writeAgentAudit({
              agentId: null,
              actorPaneKey: meta.incumbent.paneKey,
              actorHostId: hostId,
              verb: 'succession_abort',
              outcome: 'error',
              reasonCode:
                `succession=${meta.id} abort_tail_threw:${err instanceof Error ? err.message : String(err)}`.slice(
                  0,
                  200
                )
            })
            return { ok: false, code: 'succession_aborted', successionId: meta.id, reason }
          }
        )
        .then((outcome) => {
          const current = holds.get(meta.id)
          if (current && !current.settled) {
            current.settled = true
            clearHold(meta.id)
            resolve(outcome)
          }
        })
    }
    const timer = setTimeout(() => finish('timeout'), SEAL_HOLD_TIMEOUT_MS)
    const onAbort = (): void => finish('incumbent_dropped')
    signal?.addEventListener('abort', onAbort, { once: true })
    holds.set(meta.id, {
      settled: false,
      resolve,
      timer,
      onAbort,
      signal,
      record: {
        chair: meta.chair,
        incumbent: {
          paneKey: meta.incumbent.paneKey,
          terminalHandle: meta.incumbent.terminalHandle
        },
        runId: meta.runId
      }
    })
  })
}

/** G1 repair B3: runs UNDER `chairLockKey(chair)` — the SAME lock `chair-succession-accept.ts`
 * takes before moving a record to `confirming`. Re-reads state INSIDE the lock and does nothing
 * (no close, no write) once it is `confirming`/`confirmed`/`aborted` — accept having already won
 * the lock and moved past `launching` is exactly the signal that closing anything here would
 * strand a pane accept is about to use (or already used). Shared by `holdSealRequest`'s own
 * timeout/drop paths and `launchSuccessor`'s spawn-failure path (which calls `settleHold` directly
 * since there is no successor pane yet to close, and the record is still `sealed`, untouched by
 * this lock). */
export async function runAbortTail(
  deps: ChairSuccessionDeps,
  hostId: string,
  chair: string,
  successionId: string,
  reason: string
): Promise<HoldOutcome> {
  return withPaneLock(chairLockKey(chair), async () => {
    const current = await read(storeDepsFor(deps), chair, successionId)
    if (!current || current.state !== 'launching') {
      return { ok: false, code: 'succession_aborted', successionId, reason: 'already_terminal' }
    }
    if (current.successor.terminalHandle) {
      try {
        await deps.runtime.closeTerminal(current.successor.terminalHandle)
      } catch {
        // best-effort — the successor pane may already be gone.
      }
    }
    await transitionLocked(storeDepsFor(deps), chair, successionId, 'aborted', {
      abortReason: reason
    })
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: current.incumbent.paneKey,
      actorHostId: hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: `succession=${successionId} reason=${reason}`.slice(0, 200)
    })
    return { ok: false, code: 'succession_aborted', successionId, reason }
  })
}
