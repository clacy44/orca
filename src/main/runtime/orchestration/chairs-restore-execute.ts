// S10-21d b4 (design-r105-r112 ITEM 2 D4/D6/D7; s10-21d-design-v1 DEC-2): the executor. Gathers
// the planner's inputs from the (real or faked) db/runtime, calls the pure planner, then walks
// its actions SERIALLY (one pane at a time — the pane lock and the sweep lock are respected
// inside b3's `requestChairRestore` itself, never re-implemented here), calling
// `requestChairRestore` for every `rebind`/`launch` action (which already performs its own
// in-process `registerAgentForPane` — see DEVIATION note on `executeChairsRestorePlan` below),
// writing `lastSessionId` back onto the manifest object in place, and building the verification
// table (name, pane, recorded, minted, paneLive, attested, autoRestoreArmed — [S10-21d b3b,
// D-R165 M3] no `running` column: no primitive on this surface exposes the live pty's resolved
// launch command, so `ok` is `recorded === minted && paneLive`, never a claim about the process).
import type { ChairsManifest, ChairsManifestEntry } from './chairs-manifest'
import {
  chairTargetSessionId,
  planChairsRestore,
  type ChairPlanLookup,
  type ChairsRestorePlan
} from './chairs-restore-plan'
import {
  publishAfterRestore,
  retryDeferredRestoreActions,
  runRestoreAction,
  type DeferredRestoreAction,
  type RestoreActionResult
} from './chairs-restore-settle-retry'

export type RequestChairRestoreOutcome =
  | {
      ok: true
      paneKey: string
      agentId: string
      holderPaneKey: string | null
      adoptionSignal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | 'SAME_GEN_PTY_ABSENCE' | null
    }
  | { ok: false; reason: string; holderPaneKey?: string; detail?: string }

/** Everything the executor needs from the host — real `OrchestrationDb` + `OrcaRuntimeService`
 * methods in production, faked in `chairs-restore-execute.test.ts`. Kept narrow (method
 * signatures, not the classes themselves) so a fake never has to satisfy either class's full
 * surface. */
export type ChairsRestoreExecutorDeps = {
  hostId: string
  // [S10-21d b3b, D-R165 H1 fix] The machine-distinct id (`os.hostname()`) a manifest entry's
  // `host` field is compared against — NEVER `hostId` above, which is the orchestration-
  // compatibility constant ('local' on every host) and made every entry compare as local.
  machineId: string
  getAgentByName: (hostId: string, name: string) => { pane_key: string | null } | undefined
  paneHoldingSession: (hostId: string, sessionId: string) => string | undefined
  newestLaunchForPane: (hostId: string, paneKey: string) => { session_id: string } | undefined
  isPaneLive: (paneKey: string) => boolean
  requestChairRestore: (request: {
    worktreeSelector: string
    sessionId: string
    displayName: string
    role?: string
    model?: string
    effort?: string
    // [S10-22a Wave 2 contract, D-R217] threaded straight from the manifest entry — see
    // chair-restore.ts's `ChairRestoreRequest.launchArgs` for the join-by-space caveat.
    launchArgs?: string[]
  }) => Promise<RequestChairRestoreOutcome>
  // [S10-21d b3b, D-R165 M5] null = the hook-report check is unwired — never a wired false.
  hasLiveHookReportOfSession: (sessionId: string) => boolean | null
  hasResumableTranscriptTurn: (agentType: string, sessionId: string) => Promise<boolean>
  // Wait used once per run when a chair is refused as `same_generation_settling`; tests inject it.
  sleep?: (ms: number) => Promise<void>
  // Run once after at least one chair was rebound/launched: push fresh live-session marks to the
  // renderer, and queue the restored panes for a visible tab. Neither may fail the restore.
  publishLiveAgentSessionMarks?: () => Promise<void>
  materializeRestoredPanes?: () => Promise<void>
}

// The verification row buildVerificationRow always returns — split out so that function's
// return type stays narrow (its callers never need to re-narrow away the refuse/error variants).
export type ChairsRestoreVerificationRow = {
  name: string
  kind: 'skip_live' | 'rebind' | 'launch'
  paneKey: string
  recorded: string | null
  minted: string
  paneLive: boolean
  // [S10-21d b3b, D-R165 M5, corrected per D-R170 M8, corrected per D-R171 NM-3] null = the
  // hook-report check is unwired (never observed), not "no live report" — CLI/JSON prints
  // `reported=unknown`, distinct from a wired false. NOT a liveness attestation: any pane's
  // last hook report naming this session counts, at any age — only a hydrated
  // (restoredUnconfirmed) or dismissed (retainedForLiveness) row is age-bounded at
  // AGENT_STATUS_STALE_AFTER_MS; an ordinary row counts even from a dead pane's frozen
  // pre-restart timestamp — `ok` never reads this field.
  attested: boolean | null
  autoRestoreArmed: boolean
  ok: boolean
}

export type ChairsRestoreResultRow =
  | ChairsRestoreVerificationRow
  | {
      name: string
      kind: 'refuse'
      reason: string
      holderPaneKey: string
      ok: false
      detail?: string
    }
  | { name: string; kind: 'error'; reason: string; ok: false; detail?: string }

export type ChairsRestoreExecutionSummary = {
  plan: ChairsRestorePlan
  rows: ChairsRestoreResultRow[]
  exitNonZero: boolean
  // [S10-21d b3b, D-R165 L5] True iff any entry's `lastSessionId` write-back actually changed.
  changed: boolean
}

/** Gathers the planner's per-chair lookups from the db/runtime — the ONLY place executeChairs*
 * functions touch IO for the decision inputs (the planner itself stays pure). */
export function gatherChairsRestoreLookups(
  manifest: ChairsManifest,
  deps: Pick<
    ChairsRestoreExecutorDeps,
    'hostId' | 'machineId' | 'getAgentByName' | 'paneHoldingSession' | 'isPaneLive'
  >
): Map<string, ChairPlanLookup> {
  const lookups = new Map<string, ChairPlanLookup>()
  for (const entry of manifest.chairs) {
    if (entry.host !== undefined && entry.host !== deps.machineId) {
      continue
    }
    const row = deps.getAgentByName(deps.hostId, entry.name)
    const ownRow = row
      ? { paneKey: row.pane_key, isLive: row.pane_key !== null && deps.isPaneLive(row.pane_key) }
      : null
    const sessionId = chairTargetSessionId(entry)
    const holderPaneKey = deps.paneHoldingSession(deps.hostId, sessionId) ?? null
    const holder = {
      paneKey: holderPaneKey,
      isLive: holderPaneKey !== null && deps.isPaneLive(holderPaneKey)
    }
    lookups.set(entry.name, { ownRow, holder })
  }
  return lookups
}

async function buildVerificationRow(
  entry: ChairsManifestEntry,
  kind: 'skip_live' | 'rebind' | 'launch',
  paneKey: string,
  deps: ChairsRestoreExecutorDeps
): Promise<ChairsRestoreVerificationRow> {
  const minted = chairTargetSessionId(entry)
  const launchRow = deps.newestLaunchForPane(deps.hostId, paneKey)
  const recorded = launchRow?.session_id ?? null
  const paneLive = deps.isPaneLive(paneKey)
  const attested = deps.hasLiveHookReportOfSession(minted)
  const autoRestoreArmed = await deps.hasResumableTranscriptTurn(entry.agent, minted)
  // [S10-21d b3b, D-R165 M3] "running" dropped — no primitive on this surface exposes the live
  // pty's resolved launch command, so recorded/paneLive is all this table can honestly claim.
  const ok = recorded === minted && paneLive
  return {
    name: entry.name,
    kind,
    paneKey,
    recorded,
    minted,
    paneLive,
    attested,
    autoRestoreArmed,
    ok
  }
}

/** Walks `plan.actions` SERIALLY, calls `requestChairRestore` for `rebind`/`launch`, writes
 * `lastSessionId` back onto `manifest` in place (mutating the caller's object — the CLI handler
 * persists it to disk after this returns), and returns the verification rows + a loud non-zero
 * signal when anything is short.
 *
 * DEVIATION (see RETURN): the brief's step 3 names an explicit
 * `registerAgentForPane(name, role)` call for launched/rebound panes — but b3's
 * `requestChairRestore` ALREADY performs that registration in-process (orca-runtime.ts, verified
 * by reading the method before starting this brief). A second call here would be a redundant
 * re-registration of the same pane on every restore; this executor relies on the one
 * `requestChairRestore` already makes and does not call `registerAgentForPane` a second time. */
export async function executeChairsRestorePlan(
  manifest: ChairsManifest,
  plan: ChairsRestorePlan,
  deps: ChairsRestoreExecutorDeps
): Promise<ChairsRestoreExecutionSummary> {
  // A deferred (settling) chair holds a null slot until its one retry fills it, so rows stay in
  // plan order; every slot is filled before return.
  const rows: (ChairsRestoreResultRow | null)[] = []
  const deferred: DeferredRestoreAction[] = []
  let anySucceeded = false
  let exitNonZero = false
  // [S10-21d b3b, D-R165 L5] Only true once a write-back actually changes an entry — the caller
  // (chairs-restore.ts) skips rewriting the manifest file when this stays false.
  let changed = false
  const byName = new Map(manifest.chairs.map((entry) => [entry.name, entry]))
  const settle = (slot: number, result: RestoreActionResult): void => {
    rows[slot] = result.row
    exitNonZero ||= result.failed
    changed ||= result.changed
    anySucceeded ||= result.succeeded
  }

  for (const action of plan.actions) {
    const entry = byName.get(action.name)
    if (!entry) {
      rows.push({ name: action.name, kind: 'error', reason: 'manifest entry vanished', ok: false })
      exitNonZero = true
      continue
    }

    if (action.kind === 'refuse') {
      rows.push({
        name: action.name,
        kind: 'refuse',
        reason: action.reason,
        holderPaneKey: action.holderPaneKey,
        ok: false
      })
      exitNonZero = true
      continue
    }

    if (action.kind === 'skip_live') {
      const row = await buildVerificationRow(entry, 'skip_live', action.paneKey, deps)
      rows.push(row)
      if (!row.ok) {
        exitNonZero = true
      }
      continue
    }

    const result = await runRestoreAction(action, entry, true, deps, buildVerificationRow)
    if (result === null) {
      // Settling: no row yet — one shared wait and one retry after the loop.
      deferred.push({ slot: rows.length, action, entry })
      rows.push(null)
    } else {
      rows.push(null)
      settle(rows.length - 1, result)
    }
  }

  for (const { slot, result } of await retryDeferredRestoreActions(
    deferred,
    deps,
    buildVerificationRow
  )) {
    settle(slot, result)
  }
  if (anySucceeded) {
    // Fire-and-forget: this runs inside the caller's manifest lock and the CLI is waiting, and
    // publishAfterRestore can neither throw nor reject.
    void publishAfterRestore(deps)
  }

  return {
    plan,
    rows: rows.filter((row): row is ChairsRestoreResultRow => row !== null),
    exitNonZero,
    changed
  }
}

/** One-shot convenience: gather lookups, plan, execute. The CLI handler (via the RPC method)
 * calls this after parsing/validating the manifest. */
export async function runChairsRestore(
  manifest: ChairsManifest,
  deps: ChairsRestoreExecutorDeps,
  only?: ReadonlySet<string>
): Promise<ChairsRestoreExecutionSummary> {
  const lookups = gatherChairsRestoreLookups(manifest, deps)
  const plan = planChairsRestore(manifest, deps.machineId, lookups, only)
  return executeChairsRestorePlan(manifest, plan, deps)
}
