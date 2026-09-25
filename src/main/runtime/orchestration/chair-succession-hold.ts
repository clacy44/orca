// S10-22a WAVE 2 (D-R215 §Protocol steps 4/7): launch the successor, hold the incumbent's `succeed`
// call open like a parking wait, and abort (timeout or the incumbent's connection dropping first).
// The confirm ("Act") tail lives in chair-succession-accept.ts, which calls `settleHold` directly
// once it finishes — this file never itself transitions a succession to `confirmed`.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { transition, read, type ChairSuccessionStoreDeps } from './chair-succession-store'
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
 * spawn failure aborts immediately (`settleHold`) rather than waiting out the 150 s hold. */
export async function launchSuccessor(
  deps: ChairSuccessionDeps,
  hostId: string,
  entry: ManifestEntryWithSuccession,
  meta: SuccessionMeta
): Promise<void> {
  try {
    const clientOperationId = `${Date.now()}-${randomBytes(16).toString('hex')}`
    const created = await deps.runtime.createAgentSession({
      clientOperationId,
      worktree: entry.worktree,
      agent: 'claude',
      prompt: `orca chairs succession-accept ${meta.id}`,
      promptDelivery: 'auto-submit',
      ...(entry.launchArgs ? { agentArgs: entry.launchArgs.join(' ') } : {}),
      ...(entry.model || entry.effort
        ? {
            launchPreferences: {
              ...(entry.model ? { model: entry.model } : {}),
              ...(entry.effort ? { effort: entry.effort } : {})
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

type HoldEntry = {
  settled: boolean
  resolve: (outcome: HoldOutcome) => void
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
  signal?: AbortSignal
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

/** Resolves a still-open hold — a no-op once already settled or never registered. The confirm
 * path (chair-succession-accept.ts) calls this directly once its own work is done, since a
 * confirmed succession's incumbent pane is already closed by then and nothing needs an abort
 * tail run on its behalf. */
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
      void runAbortTail(deps, hostId, meta.id, reason).then((outcome) => {
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
    holds.set(meta.id, { settled: false, resolve, timer, onAbort, signal })
  })
}

/** Runs the abort tail: close the successor pane if one was launched, transition to `aborted`,
 * audit. Shared by `holdSealRequest`'s own timeout/drop paths and `launchSuccessor`'s spawn-
 * failure path (which calls `settleHold` directly since there is no successor pane yet to
 * close). */
export async function runAbortTail(
  deps: ChairSuccessionDeps,
  hostId: string,
  successionId: string,
  reason: string
): Promise<HoldOutcome> {
  const current = await readCurrent(deps, successionId)
  if (!current || current.state === 'confirmed' || current.state === 'aborted') {
    return { ok: false, code: 'succession_aborted', successionId, reason: 'already_terminal' }
  }
  if (current.successor.terminalHandle) {
    try {
      await deps.runtime.closeTerminal(current.successor.terminalHandle)
    } catch {
      // best-effort — the successor pane may already be gone.
    }
  }
  await transition(storeDepsFor(deps), current.chair, successionId, 'aborted', {
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
}

/** wave 1's `read(deps, chair, id)` needs `chair` — scan every chair directory once (bounded by
 * the manifest's chair count) rather than widening that store export's signature. */
export async function readCurrent(
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
