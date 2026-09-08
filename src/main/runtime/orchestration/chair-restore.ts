// S10-21d b3b (D-R163 M4 fix, MAX-LINES): `requestChairRestore` extracted out of orca-runtime.ts
// to keep its ratchet — the class keeps only a thin call site forwarding `{ runtime: this }` as
// `deps` (see `ChairRestoreDeps`'s own doc for why a single-field deps object).
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeEnsureAgentSessionResult } from '../../../shared/agent-session-host-authority'
import type { AgentRow } from './types'
import { decideEarlyRows } from './restore-sweep-decision'
import { collectSweepEvidence } from './restore-sweep-evidence'
import { resolveHolderAdoption, type HolderAdoptionRefusalReason } from './dead-holder-adoption'
import { registerAgentForPane } from './register-agent-for-pane'
import { isRestoreSweepLockHeld } from '../restore-sweep-lock'
import { resolveResumeTranscript } from '../../startup/resolve-resume-transcript'
import { preflightResumeTranscript } from '../../ipc/agent-launch-admission-support'
import { resolveIncumbentDeath, type IncumbentVerdict } from '../incumbent-death'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'

// `requestChairRestore`'s dependency: the concrete `OrcaRuntimeService`, not a narrow method-list
// interface — `registerAgentForPane` below already requires the concrete class, so narrowing
// here would still widen back to it at that one call. Type-only import, no runtime cycle.
export type ChairRestoreDeps = {
  runtime: OrcaRuntimeService
}

// [S10-21d b3, DEC-2] The launcher's own restore: mints a ticket for `sessionId` — adopting a
// DEAD holder pane per DEC-3, or recording an unheld restore with no supersede — then opens the
// pane through the SAME HOST_RESUME arm the sweep uses, and registers displayName/role in
// process. A LIVE holder refuses loudly (DEC-2's "no fork, no stub"). model/effort (b4, DEC-9/
// R118) thread through as launchPreferences when given. Extracted from orca-runtime.ts in b3b
// (D-R163 M4/MAX-LINES) to keep that file's ratchet.
// Named (not inlined at the call below) so orca-runtime.ts's thin wrapper can import these
// instead of deriving them via Parameters<>/ReturnType<> locally — one fewer pair of type
// aliases against that file's own line ratchet.
export type ChairRestoreRequest = {
  worktreeSelector: string
  sessionId: string
  displayName: string
  role?: string
  model?: string
  effort?: string
}
export type ChairRestoreResult =
  | {
      ok: true
      paneKey: string
      agentId: string
      holderPaneKey: string | null
      adoptionSignal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | null
    }
  | { ok: false; reason: 'restore_target_live_elsewhere'; holderPaneKey: string }
  | { ok: false; reason: HolderAdoptionRefusalReason; holderPaneKey: string }
  | { ok: false; reason: string }

export async function requestChairRestore(
  deps: ChairRestoreDeps,
  request: ChairRestoreRequest
): Promise<ChairRestoreResult> {
  const db = deps.runtime.getOrchestrationDb()
  const hostId = deps.runtime.getOrchestrationCompatibilityHostId()
  const agentType = 'claude'
  const currentLaunchGeneration = deps.runtime.getLaunchGenerationId()

  // [S10-21d b3b, D-R163 H3 fix] Resolve the ADOPTING side's real execution host BEFORE the
  // predicate — `getOrchestrationCompatibilityHostId()` is always 'local', so conjunct B was
  // vacuous when fed that constant. Reuses the SAME resolver `ensureAgentSession` uses below,
  // so this check and the actual launch can never disagree about where the worktree lives.
  let adoptingExecutionHostId: string
  try {
    const workspace = await deps.runtime.resolveTerminalWorkspaceLaunchScope(
      request.worktreeSelector
    )
    adoptingExecutionHostId = workspace.connectionId
      ? toSshExecutionHostId(workspace.connectionId)
      : workspace.repo
        ? getRepoExecutionHostId(workspace.repo)
        : LOCAL_EXECUTION_HOST_ID
  } catch (err) {
    return {
      ok: false,
      reason: `restore_worktree_resolution_failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (adoptingExecutionHostId !== LOCAL_EXECUTION_HOST_ID) {
    return { ok: false, reason: 'restore_target_not_local' }
  }

  const holderPaneKey = db.paneHoldingSession(hostId, request.sessionId) ?? null
  let adoptionSignal: 'IDENTITY' | 'D1' | 'GEN_ABSENCE' | null = null
  // [S10-21d b3b, D-R163 H2] set in the holder branch, read after registration for the audit rows.
  let holderGenerationForAudit: string | null = null
  let holderRegisteredForAudit: AgentRow | undefined

  if (holderPaneKey !== null) {
    const holderLaunchRow = db.newestLaunchForPane(hostId, holderPaneKey)
    const parsed = parsePaneKey(holderPaneKey)
    if (!parsed) {
      return { ok: false, reason: 'restore_target_unresolvable' }
    }
    const inventory = await deps.runtime.takeControllerInventoryForSweep()
    const holderRegistered = db.getAgentByPaneKey(hostId, holderPaneKey)
    holderGenerationForAudit = holderLaunchRow?.launch_generation ?? null
    holderRegisteredForAudit = holderRegistered
    const early = decideEarlyRows(holderRegistered?.process_incarnation ?? null, inventory)

    let incumbent: IncumbentVerdict
    let d2Inventory: 'present' | 'absent' | 'unknown'
    let inventoryRoundNonNull: boolean
    let holderHasConnectedPty = deps.runtime.findConnectedPtyForPane(holderPaneKey) !== undefined
    if (early.kind === 'skipped_daemon_survived') {
      incumbent = { dead: false, reason: 'live' }
      d2Inventory = 'present'
      inventoryRoundNonNull = true
    } else if (early.kind === 'layer3') {
      // [JUDGMENT CALL, see RETURN] 'layer3' covers a null round AND an ambiguous-pty identity
      // — collapsed to "insufficient evidence" either way: never wrongly grants, may over-refuse.
      incumbent = { dead: false, reason: 'inventory_unknown' }
      d2Inventory = 'unknown'
      inventoryRoundNonNull = false
    } else {
      const evidenceBundle = await collectSweepEvidence(
        deps.runtime,
        holderPaneKey,
        parsed.tabId,
        parsed.leafId,
        hostId,
        inventory,
        early.identity,
        early.status
      )
      incumbent = resolveIncumbentDeath(evidenceBundle.incumbentEvidence)
      d2Inventory = evidenceBundle.incumbentEvidence.d2.inventory
      inventoryRoundNonNull = true
      holderHasConnectedPty = holderHasConnectedPty || evidenceBundle.occupantLiveness === 'present'
    }

    if (!incumbent.dead && incumbent.reason === 'live') {
      return { ok: false, reason: 'restore_target_live_elsewhere', holderPaneKey }
    }

    const holderExecutionHostId = holderLaunchRow?.execution_host_id ?? hostId
    // [JUDGMENT CALL, see RETURN; S10-21d b3b, D-R163 LOW fix] Conjunct F: every live
    // registered row sharing the holder pane's suffix, if any, must name the SAME chair — a
    // different live name refuses, reclaiming this restore's own prior identity does not.
    // Listing all suffix matches (not one `getAgentByPaneKey` pick) is defense-in-depth for a
    // live, differently-named sibling row, should `idx_agents_pane_suffix`'s uniqueness ever
    // relax.
    const holderHasOtherLiveRegisteredRow = db
      .listAgentsByPaneKeySuffix(hostId, holderPaneKey)
      .some((row) => {
        if (row.display_name === request.displayName) {
          return false
        }
        const signals = deps.runtime.getAgentDirectoryLivenessSignals(row.pane_key ?? holderPaneKey)
        return signals.terminalHandle !== null || signals.observedLive
      })

    const preflight = await preflightResumeTranscript(
      resolveResumeTranscript,
      agentType,
      request.sessionId
    )

    const decision = resolveHolderAdoption({
      holderPaneKey,
      // [JUDGMENT CALL, see RETURN; S10-21d b3b, D-R163 LOW fix: sentinel wording] The adopting
      // pane does not exist yet (ensureAgentSession below mints it). Real pane keys are
      // `<tabId>:<leafId>` (both UUIDs, colon-separated — db.ts's paneKeyMatchSuffix); this
      // literal has no colon, so it can never collide with one — conjunct A is vacuous here.
      adoptingPaneKey: '<pending-launcher-restore>',
      holderExecutionHostId,
      adoptingExecutionHostId,
      holderLaunchGeneration: holderLaunchRow?.launch_generation ?? null,
      currentLaunchGeneration,
      incumbent,
      d2Inventory,
      inventoryRoundNonNull,
      holderHasConnectedPty,
      // [S10-21d b3b, D-R163 M1 fix] Exclude the holder's own stale rehydrated row (OD-21d-1).
      // [b3b M5] null (unwired) coerces to false here — conservative, matches DEC-3's own default.
      liveHookReportOfSessionElsewhere:
        deps.runtime.hasLiveHookReportOfSession(request.sessionId, {
          excludePaneKey: holderPaneKey
        }) ?? false,
      sweepLockHeld: isRestoreSweepLockHeld(),
      sweepRestoreMarkSetForHolder: db.getSweepRestoreMark(hostId, holderPaneKey),
      holderHasOtherLiveRegisteredRow,
      transcriptPreflightPassed: preflight.ok
    })
    if (!decision.adoptable) {
      return { ok: false, reason: decision.reason, holderPaneKey }
    }
    // [S10-21d b3b, D-R163 H2 fix] Clamp per holder pane before minting (house rate limiter).
    const rate = db.checkAndBumpRate({
      subjectKey: holderPaneKey,
      verb: 'session_adopt',
      windowMs: 3_600_000,
      limit: 5
    })
    if (!rate.allowed) {
      return { ok: false, reason: 'adoption_rate_limited' }
    }
    adoptionSignal = decision.signal
  } else {
    // No holder: unheld restore (DEC-2) — refuse rather than record a non-resumable session.
    const preflight = await preflightResumeTranscript(
      resolveResumeTranscript,
      agentType,
      request.sessionId
    )
    if (!preflight.ok) {
      return { ok: false, reason: preflight.reasonCode }
    }
  }

  // [S10-21d b3b, D-R163 LOW fix] `mintLauncherRestoreTicket` (dup of `mintRestoreTicket`,
  // same registry instance) deleted — this calls the sweep's own mint point directly.
  const ticket = deps.runtime.mintRestoreTicket({
    predecessorPaneKey: holderPaneKey,
    sessionId: request.sessionId,
    // [S10-21d b3b, D-R163 H3 fix] resolved worktree host, never the compat constant.
    executionHostId: adoptingExecutionHostId,
    launchGeneration: currentLaunchGeneration
  })

  let created: RuntimeEnsureAgentSessionResult
  try {
    created = await deps.runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: request.worktreeSelector,
        agent: 'claude',
        providerSession: { key: 'session_id', id: request.sessionId },
        presentation: 'background',
        ...(request.model || request.effort
          ? {
              launchPreferences: {
                ...(request.model ? { model: request.model } : {}),
                ...(request.effort ? { effort: request.effort } : {})
              }
            }
          : {})
      },
      {},
      { restoreProvenance: { kind: 'host-restore', ticket, evidence: 'host_restore' } }
    )
  } catch (err) {
    return {
      ok: false,
      reason: `ensure_agent_session_failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const newPaneKey = created.terminal.paneKey
  if (!newPaneKey) {
    return { ok: false, reason: 'restore_pane_key_missing' }
  }
  const newTerminalHandle = created.terminal.handle
  const registration = await registerAgentForPane(db, deps.runtime, {
    paneKey: newPaneKey,
    terminalHandle: newTerminalHandle,
    processIncarnation: deps.runtime.getTerminalProcessIncarnation(newTerminalHandle),
    displayName: request.displayName,
    role: request.role
  })
  if (!registration.ok) {
    return { ok: false, reason: `register_failed: ${registration.reason}` }
  }
  // [S10-21d b3b, D-R163 H2 fix] Loud trace for every adoption — new-pane 'session_adopted' +
  // holder 'superseded' audit rows + a pane notice (a plain HOST_RESUME writes none of this).
  if (holderPaneKey !== null && adoptionSignal !== null) {
    const reasonCode =
      `signal=${adoptionSignal} holder=${holderPaneKey} ` +
      `holder_generation=${holderGenerationForAudit} session=${request.sessionId}`
    db.writeAgentAudit({
      agentId: registration.agent.id,
      actorPaneKey: newPaneKey,
      actorHostId: hostId,
      verb: 'session_adopted',
      outcome: 'adopted',
      reasonCode
    })
    if (holderRegisteredForAudit) {
      db.writeAgentAudit({
        agentId: holderRegisteredForAudit.id,
        actorPaneKey: holderPaneKey,
        actorHostId: hostId,
        verb: 'superseded',
        outcome: 'superseded',
        reasonCode: `superseded by pane=${newPaneKey} agent=${registration.agent.id}`
      })
    }
    deps.runtime.writeHostNoticeToPane(
      newPaneKey,
      `Session adopted from ${holderPaneKey} (${adoptionSignal}).`,
      { rateKey: 'session_adopted' }
    )
  }
  return {
    ok: true,
    paneKey: newPaneKey,
    agentId: registration.agent.id,
    holderPaneKey,
    adoptionSignal
  }
}
