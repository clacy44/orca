// S10-22a WAVE 2 (D-R215 §Protocol steps 4/7): hold the incumbent's `succeed` call open like a
// parking wait, and abort (timeout or the incumbent's connection dropping first). The launch
// itself lives in chair-succession-launch-successor.ts (line ratchet); the confirm ("Act") tail
// lives in chair-succession-accept.ts, which calls `settleHold` directly once it finishes — this
// file never itself transitions a succession to `confirmed`.
//
// G1 repair B5: `holds` is the SOURCE OF TRUTH for the incumbent's pane/handle/chair/runId once a
// hold is registered — `getHoldRecord` is what `chair-succession-accept.ts` reads instead of
// trusting `meta.json` (a same-uid writer can plant an arbitrary meta.json at a validly-shaped
// path; it cannot forge an in-process Map entry). The record is populated from `meta` at
// `holdSealRequest` registration time, i.e. straight from `sealSuccession`'s own just-created,
// fully-trusted return value — never from a later disk re-read.
import {
  chairLockKey,
  read,
  transitionLocked,
  withPaneLock,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'
import type { ChairSuccessionDeps } from './chair-succession-execute'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
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

/** Mirrors the successor pane/handle onto a still-live hold once `launchSuccessor`
 * (chair-succession-launch-successor.ts) records it in the store — a no-op once
 * settled/never registered. Keeps `holds` itself private to this module (B5). */
export function setHoldSuccessor(
  id: string,
  successor: { paneKey: string; terminalHandle: string }
): void {
  const entry = holds.get(id)
  if (entry && !entry.settled) {
    entry.record.successor = successor
  }
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
    // A signal already aborted before the hold registers never fires its 'abort' event (Node's
    // AbortSignal does not replay past events to a listener added after the fact) — without this
    // check the hold stays live for the full 150s timeout although the incumbent's connection was
    // already gone at registration time (chair ruling: "a pre-aborted signal finishes
    // immediately").
    if (signal?.aborted) {
      finish('incumbent_dropped')
    }
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
    // N1: `sealed` is NOT terminal — createAgentSession may still be in flight (no successor
    // pane recorded yet). Abort it here too (sealed→aborted is legal); `launchSuccessor`'s own
    // re-read under this same lock is what closes the pane once it lands.
    if (!current || (current.state !== 'launching' && current.state !== 'sealed')) {
      return { ok: false, code: 'succession_aborted', successionId, reason: 'already_terminal' }
    }
    if (current.state === 'launching' && current.successor.terminalHandle) {
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
