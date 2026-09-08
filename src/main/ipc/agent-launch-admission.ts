// S10-21a C3-v2 (errata 5(p) v2.1 §B, §C.1-§C.4, §C.6, §G): the one launch-admission point.
// `spawnWithLane` (lane-pinned-spawn.ts) calls `admitAgentLaunch` between the lane computation
// and the provider call. [D-R104 F-8 fix] The (hostId, paneKey) lock spans ONLY the ownership
// read + row write below — released before `provider.spawn` runs (errata 5(v)); `confirm`/
// `compensate` bracket the spawn itself, outside the lock, run after/on-throw. This module
// never touches the restore-ticket
// registry (C2) or the pane-key gate (C3a-v2) — it consumes what its caller already redeemed.
// Split across agent-launch-classification.ts (pure token scanners) and
// agent-launch-admission-lock.ts (the (host,pane) mutex) to stay under the max-lines budget.
import { randomUUID } from 'node:crypto'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import { spliceHostMintedSessionId } from '../../shared/agent-resume-launch-command'
import { isCoveredLaunchAgent } from '../../shared/covered-launch-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import { isSessionId } from '../../shared/stable-pane-id'
import type {
  LaunchEvidence,
  RecordLaunchParams
} from '../runtime/orchestration/agent-launch-sessions'
import { resolveResumeTranscript } from '../startup/resolve-resume-transcript'
// [JUDGMENT CALL, see RETURN] `OrchestrationDb` (db.ts), not the raw `Database.Database` the
// store module (agent-launch-sessions.ts) takes: `OrchestrationDb.db` is private with no public
// accessor, so a pty.ts call site — which only ever holds `runtime.getOrchestrationDb()` — cannot
// obtain a raw handle. Every store call below goes through OrchestrationDb's existing public
// delegate methods (recordLaunch/newestLaunchForPane/getAgentByPaneKey/writeAgentAudit, plus the
// deleteLaunchRow delegate this commit adds to db.ts — the only one that was missing).
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { LaunchAdmissionRefusedError } from './agent-launch-admission-errors'
import {
  resolveHostResumeRecordLaunch,
  hostResumeOnRowDeleted
} from './agent-launch-admission-host-resume'
import { withPaneLock } from './agent-launch-admission-lock'
import {
  audit,
  passThrough,
  preflightResumeTranscript,
  type AdmittedLaunch,
  type LaunchAdmissionClassification
} from './agent-launch-admission-support'
import {
  claudeIndexInSubject,
  resolveAdmissionShell,
  resolveExecutedChannel,
  scanEffectiveResumeId,
  scanRefusal,
  locateClaude,
  tokensOfSubject
} from './agent-launch-classification'

export { LaunchAdmissionRefusedError } from './agent-launch-admission-errors'

/** [errata 5(p) v2.1 §C.5] non-wire. REQUIRED on `RuntimePtyController.spawn`'s opts (C3-v2c) and
 * as `spawnWithLane`'s 4th parameter (this commit). NEVER on `PtySpawnOptions` — so it reaches no
 * provider, no socket, no daemon, and no persisted record. A compile-time fence
 * (`agent-launch-admission-host-resume-literal-fence.test.ts`, D-R104 F-14) asserts no
 * rpc/ipc-schema/relay/renderer/preload/shared module names 'host-resume'. */
export type LaunchAdmission =
  | { kind: 'caller'; sequencedAgentLine?: string }
  | {
      kind: 'host-resume'
      sessionId: string
      predecessorPaneKey: string | null // [DEC-2] null: launcher restore, no pane on host holds it
      executionHostId: string
      launchGeneration: string
      launchSeq?: number
      evidence?: Extract<LaunchEvidence, 'sweep_record' | 'host_restore'> // [DEC-2] default sweep_record
      sequencedAgentLine?: string
    }

export type AgentLaunchAdmissionContext = {
  hostId: string
  executionHostId: string
  launchGeneration: string
  /** [D-R104 F-3] REQUIRED — every production caller (launchAdmissionBundle, pty.ts) now wires a
   * real pane notice; a caller cannot silently omit it and have every UNRECORDED/self-resume
   * signal go audit-only. [§2.6] Raised on SELF_RESUME(caller) into a registered pane and on
   * every UNRECORDED. */
  notice: (paneKey: string, verb: string, reasonCode: string) => void
  /** [D-R104 F-3] REQUIRED, same reasoning as `notice`. [§C.4 SELF_RESUME v2.1 V1] The §2.6
   * contested-lineage signal — [S10-21a C6b, Ruling 34 Addendum 19] audit verb 'launch', outcome
   * 'contested', attributed to the registered row (`registeredAgentId`) — plus a pane notice.
   * [S10-21a C6, SCOPE 3(b)] `registeredPaneKey` is the registered agent's OWN pane_key
   * (`getAgentByPaneKey` matches by pane SUFFIX — derived-agent-rows.ts:22-34 — so it can
   * legitimately differ from `claimantPaneKey`, the pane the caller-origin SELF_RESUME actually
   * landed on). The runtime-side handler notices BOTH when they differ, one when they don't. */
  contestedLineage: (
    claimantPaneKey: string,
    registeredPaneKey: string,
    registeredAgentId: string
  ) => void
}

export type { AdmittedLaunch } from './agent-launch-admission-support'

/** [D-R104 F-4/F-5] Shared confirm/compensate builder for a launch that recorded a row —
 * HOST_MINTED and (now) HOST_RESUME both close over it. `onRowDeleted` runs whenever the row is
 * actually deleted (surface divergence at confirm, or a spawn failure at compensate) — HOST_RESUME
 * uses it to restore the predecessor pane's current_sessions row; HOST_MINTED has none to restore.
 *
 * [D-R104 F-5 fix] `compensate(true)` (the `agentSessionOwners.ensure` post-callback-throw path,
 * pty.ts) is tracked by its OWN `ensureFailureAudited` flag, independent of `settled` — it must
 * still fire (and audit) even after `confirm` already ran and set `settled`, because it reports a
 * LATER, separate failure than anything `confirm`/`compensate(false)` already resolved, and it
 * never mutates the row (`§C.6`: never destroy a fact not proven false), so it cannot race either
 * of them. */
function buildRecordedAdmission(
  db: OrchestrationDb,
  ctx: AgentLaunchAdmissionContext,
  paneKey: string,
  seq: number,
  spawnOptions: PtySpawnOptions,
  /** [S10-21c B3] Optional: the caller-resume path below records a row but claims NO
   * classification. Every existing value would be a lie (`host_minted` means the host minted the
   * id; `self_resume_*` means the pane's own newest row) and a NEW value would have to be added
   * to the renderer-facing `LaunchAdmissionNoticeClassification` wire enum
   * (src/shared/launch-admission-notice.ts) — a wire change this brief does not carry. Omitting
   * it is behaviour-preserving at both consumers: `resolveDaemonRespawnGateAction` returns
   * `{kind:'none'}` for undefined exactly as it does for today's 'unrecorded', and pty.ts's
   * push at :6973 is already `admittedLaunch?.classification`-gated (the renderer's own
   * reconciliation maps 'UNRECORDED' to `{kind:'none'}` too). */
  classification?: LaunchAdmissionClassification,
  onRowDeleted?: () => void
): AdmittedLaunch {
  let settled = false
  let ensureFailureAudited = false
  return {
    spawnOptions,
    classification,
    confirm: (spawnResult: PtySpawnResult) => {
      if (settled) {
        return
      }
      settled = true
      const surface = spawnResult.agentSessionEnsure?.owner.surface
      if (surface !== undefined) {
        // [forced deviation] Not `makePaneKey`: it throws on a malformed tabId/leafId, and
        // confirm() must never throw post-spawn. Same `tab:leaf` format, without the
        // validation — a malformed surface still compares (and, correctly, diverges).
        const actualPaneKey = `${surface.tabId}:${surface.leafId}`
        if (actualPaneKey !== paneKey) {
          db.deleteLaunchRow(seq)
          onRowDeleted?.()
          audit(db, paneKey, ctx.hostId, 'launch_surface_diverged', 'compensated', null)
          ctx.notice(paneKey, 'launch_surface_diverged', 'launch_surface_diverged')
        }
      }
    },
    compensate: (fromEnsureFailure?: boolean) => {
      if (fromEnsureFailure) {
        if (ensureFailureAudited) {
          return
        }
        ensureFailureAudited = true
        // [§C.6] The process may still be alive: never destroy a fact not proven false.
        audit(db, paneKey, ctx.hostId, 'launch_ensure_failed_after_spawn', 'compensated', null)
        return
      }
      if (settled) {
        return
      }
      settled = true
      db.deleteLaunchRow(seq)
      onRowDeleted?.()
      audit(db, paneKey, ctx.hostId, 'launch_spawn_failed', 'compensated', null)
    }
  }
}

/** [errata 5(p) v2.1 §C.1-§C.4] The one launch-admission point. Called from `spawnWithLane`
 * between the lane computation and `provider.spawn`. [D-R104 F-8 fix] The (hostId, paneKey)
 * lock below (`withPaneLock`) spans only the ownership read + row write, released before this
 * function returns to its caller — `provider.spawn` runs OUTSIDE the lock (errata 5(v)).
 *
 * [JUDGMENT CALL, see RETURN] §C.4's table lists "db attached" as step 0, ahead of coverage
 * determination — read literally, EVERY spawn (plain shells included) would refuse whenever the
 * orchestration DB is unattached. That contradicts F-12's own framing ("a COVERED launch...
 * throws") and F-H4's "a plain shell with no placement never touches the DB". This implementation
 * determines covered/sniffed/neither FIRST (channel + claude-locate, needs no DB); an UNCOVERED
 * launch returns a pass-through admission that never touches `db`, the lock, or `paneKey`. Only
 * once a launch is covered-or-sniffed does an unattached DB refuse it.
 *
 * [JUDGMENT CALL, see RETURN] `getDb` is a LAZY accessor, not an eager value: `OrchestrationDb`'s
 * own `getOrchestrationDb()` lazily creates the DB (and arms several subsystems) on first call, so
 * a caller that resolved it eagerly before calling this function would attach the DB for every
 * spawn — covered or not — reintroducing exactly the F-H4 regression (§D) this errata calls out
 * for E1. Calling `getDb()` only after coverage is established keeps that property true here too. */
export async function admitAgentLaunch(
  getDb: () => OrchestrationDb | undefined,
  spawnOptions: PtySpawnOptions,
  admission: LaunchAdmission,
  ctx: AgentLaunchAdmissionContext
): Promise<AdmittedLaunch> {
  const shell = resolveAdmissionShell(spawnOptions)
  const covered = isCoveredLaunchAgent(spawnOptions.launchAgent)
  const channelResolution = resolveExecutedChannel(spawnOptions, admission, shell)

  let sniffed = false
  if (!covered) {
    const sniffSubject = channelResolution.ok
      ? channelResolution.subject
      : (spawnOptions.command ?? '')
    sniffed = sniffSubject.length > 0 && locateClaude(sniffSubject, shell)
  }
  if (!covered && !sniffed) {
    // UNCOVERED: no classification, no write, no delete, no DB touch (§C.3).
    return passThrough(spawnOptions)
  }

  const db = getDb()
  if (!db) {
    throw new LaunchAdmissionRefusedError('launch_store_unavailable')
  }

  const paneKey = spawnOptions.paneKey
  if (paneKey === undefined) {
    audit(db, null, ctx.hostId, 'launch_unrecorded', 'admitted', 'launch_pane_unknown')
    return passThrough(spawnOptions)
  }

  const unrecorded = (reasonCode: string): AdmittedLaunch => {
    audit(db, paneKey, ctx.hostId, 'launch_unrecorded', 'admitted', reasonCode)
    ctx.notice(paneKey, 'launch_unrecorded', reasonCode)
    return passThrough(spawnOptions, 'unrecorded')
  }
  const refuse = (reasonCode: string): never => {
    audit(db, paneKey, ctx.hostId, 'launch_refused', 'refused', reasonCode)
    throw new LaunchAdmissionRefusedError(reasonCode)
  }

  if (!channelResolution.ok) {
    return unrecorded(channelResolution.reason)
  }
  // [D-R104 B-2 BLOCKER fix, §C.2 deliverability] Host-delivered iff LOCAL, or REMOTE and the
  // relay actually promised provider delivery. The relay's own default
  // (src/relay/pty-handler.ts:1524) is 'renderer' (terminal-paste) whenever the caller omits
  // `commandDelivery` at all — refusing only the literal `'renderer'` value let a remote covered
  // launch with NO `commandDelivery` through as host-delivered (production path:
  // launch-agent-background-session.ts:198-220 spawns command+launchAgent+connectionId with no
  // `commandDelivery`); the relay then discards the command
  // (pty-handler.ts:1631/:684) while admission had already minted and committed a row for it.
  const hostDelivered =
    ctx.executionHostId === LOCAL_EXECUTION_HOST_ID
      ? true
      : spawnOptions.commandDelivery === 'provider'
  if (!hostDelivered) {
    return unrecorded('command_not_host_delivered')
  }
  if (channelResolution.subject.length === 0) {
    return unrecorded('no_launch_command')
  }

  const claudeIndex = claudeIndexInSubject(channelResolution.subject, shell)
  if (claudeIndex === -1) {
    // sniffed-but-unlocatable-via-tokenizer, or covered-but-unlocatable: either way, no lineage.
    return unrecorded(covered ? 'launch_command_unlocatable' : 'sniffed_no_lineage')
  }
  const tokens = tokensOfSubject(channelResolution.subject, shell)

  const refusalReason = scanRefusal(tokens, claudeIndex)
  if (refusalReason) {
    return refuse(refusalReason)
  }

  const effectiveId = scanEffectiveResumeId(tokens, claudeIndex)

  return await withPaneLock(`${ctx.hostId}\0${paneKey}`, async () => {
    const newestRow = db.newestLaunchForPane(ctx.hostId, paneKey)
    const registeredRow = db.getAgentByPaneKey(ctx.hostId, paneKey)

    // [§C.4 "--continue ruled"] id-less/undeterminable resolution.
    if (effectiveId.kind === 'undeterminable') {
      // [S10-21c B2, design §2 S6(a)] A host-resume admission is the sweep's OWN restore
      // attempt — it names a specific predecessor session by construction (S2/HOST_MINTED
      // never sets `admission.kind: 'host-resume'`). Losing the selector here means the sweep's
      // own restore command was malformed; degrading to `unrecorded` would silently spawn an
      // untracked fresh session instead. Refuse loudly. Every OTHER admission kind keeps
      // today's `unrecorded` behavior unchanged.
      if (admission.kind === 'host-resume') {
        return refuse('restore_selector_lost')
      }
      // [S10-21c B3b, D-R149 INFO 2] The `owned ? 'pane_key_owned' : ...` ternary that used to
      // sit here is DELETED: `owned` (newestRow/registeredRow presence) has nothing to do with
      // WHY the selector could not be resolved — it made the audit lie about the actual cause
      // on every owned pane. The reason is always that the resume target could not be
      // determined; the audit now says exactly that.
      return unrecorded('resume_target_undeterminable')
    }

    if (effectiveId.kind === 'id') {
      const x = effectiveId.sessionId
      if (admission.kind === 'host-resume' && admission.sessionId === x) {
        // HOST_RESUME
        // [S10-21a C7f, D-R114 fix 2] Resume-shaped notice so a renderer store consumer can
        // clear a pane's stale sleeping-session record (see RETURN: no such consumer exists yet).
        ctx.notice(paneKey, 'launch_host_resume', 'launch_host_resume')
        // [S10-21d b3b, D-R163 H1 fix] resolveHostResumeRecordLaunch re-checks the holder fresh,
        // inside this lock, before building the write (see its own doc comment for the race).
        const params = resolveHostResumeRecordLaunch(db, ctx, {
          paneKey,
          agentType: spawnOptions.launchAgent ?? 'claude',
          sessionId: x,
          admission,
          refuse
        })
        const result = db.recordLaunch(params)
        if (!result.ok) {
          // [S10-21d b3b, D-R163 H2 LOW] unheld restore's failure IS foreign_session_id
          return refuse(admission.predecessorPaneKey ? 'launch_record_write_failed' : result.reason)
        }
        // [D-R104 F-4] A restated row is not this call's to confirm/compensate over — it was
        // already there (F-12).
        if (result.restated) {
          return passThrough(spawnOptions, 'host_resume')
        }
        return buildRecordedAdmission(
          db,
          ctx,
          paneKey,
          result.row.seq,
          spawnOptions,
          'host_resume',
          hostResumeOnRowDeleted(db, ctx.hostId, admission.predecessorPaneKey)
        )
      }
      if (newestRow !== undefined && newestRow.session_id === x) {
        // SELF_RESUME — [v2.1 V1] ALWAYS audited, no row, no splice.
        const reasonCode = admission.kind === 'host-resume' ? 'host' : 'caller'
        audit(db, paneKey, ctx.hostId, 'launch_self_resume', 'admitted', reasonCode)
        if (reasonCode === 'caller' && registeredRow !== undefined && registeredRow.derived === 0) {
          ctx.notice(paneKey, 'launch_self_resume', 'caller')
          // getAgentByPaneKey matches by pane SUFFIX (derived-agent-rows.ts) and its own WHERE
          // clause requires pane_key IS NOT NULL for any row it returns — the `?? paneKey`
          // fallback is defensive only, never actually reached.
          ctx.contestedLineage(paneKey, registeredRow.pane_key ?? paneKey, registeredRow.id)
        }
        return passThrough(
          spawnOptions,
          reasonCode === 'host' ? 'self_resume_host' : 'self_resume_caller',
          // [S10-21a C14b, D-R128 F6] Binds the renderer-funnel gate's refresh to this specific
          // registered row — two registered rows can share a pane suffix.
          reasonCode === 'caller' ? registeredRow?.id : undefined
        )
      }
      // [S10-21c B3, design §2 S2 ADDENDUM] A host-resume admission whose command RESOLVES to a
      // session id that is neither the ticket's own nor this pane's newest row: the sweep's
      // restore is about to become a FOREIGN conversation. Refuse — a restore may never silently
      // do that. Distinct from B2's `restore_selector_lost` above (there the selector is gone;
      // here it is present and points elsewhere). Unreachable for a well-formed sweep restore:
      // it builds `claude --resume <launchRow.session_id>` (agent-session-resume.ts:259) from the
      // same row whose id the ticket carries (restore-registered-agent-panes.ts:219/229), so this
      // is the defence-in-depth arm, not a routine one.
      if (admission.kind === 'host-resume') {
        return refuse('restore_selector_mismatch')
      }
      // [S10-21c B3, design §2 S2] R1's second half: a caller-typed `claude --resume X` used to
      // be dropped (`unrecorded(owned ? 'pane_key_owned' : 'foreign_selector')`), which left the
      // pane's row pinned to its FIRST session id forever and the sweep resuming a stub. X is
      // what the child will actually run — `scanRefusal` above already hard-refused
      // `--session-id`/`--fork-session` (agent-launch-classification.ts:138-150), so a covered
      // `claude --resume X` can only continue X itself — so the host records it.
      // `supersedePaneKey` is deliberately NEVER set here: it is restore-only by contract
      // (agent-launch-sessions.ts's own comment on the field), so `current_sessions`'
      // UNIQUE(host_id, session_id) stays the sole cross-pane successor fence and now does the
      // adjudication this arm used to duck. `recordLaunch`'s only non-ok result is
      // `foreign_session_id` — another pane currently holds X — and that is a hard refusal:
      // never a silent drop, never a supersede, never a `--resume` spliced behind the caller.
      // [S10-21c B3b, D-R149 MEDIUM 2] `scanEffectiveResumeId`'s own documented safety argument
      // ("a false positive here only costs coverage on one exotic command — it never breaks a
      // launch") stops being true the moment `x` is WRITTEN DOWN as the pane's resume target:
      // every other writer of this column wrote either a host-minted randomUUID or an id the
      // host already held. Require `x` to be shaped like one before it becomes durable state —
      // a mis-parsed or typo'd token is refused loudly here instead of silently becoming the
      // pane's newest row (which would cost that pane its restore until the next successful
      // launch, per B2's transcript preflight).
      if (!isSessionId(x)) {
        return unrecorded('resume_target_unparseable')
      }
      // [S10-21c B-final F4, D-R159 finding 4] X is shaped like a session id, but shape alone
      // does not prove it NAMES one — S4's own preflight (resolve-resume-transcript.ts) refuses
      // exactly this at the NEXT sweep (`sweep_resume_target_absent`), after this arm has already
      // superseded the pane's good row and cost it its automatic restore. Reuse the same resolver
      // here, before recording: a miss, an empty/stub-only transcript, or an agent type S4 does
      // not cover yet all refuse loudly (`unrecorded`, spawn still proceeds) rather than writing
      // an id that the sweep's own preflight would only tear back out later.
      const agentType = spawnOptions.launchAgent ?? 'claude'
      // [S10-21c B-final M2/M3, D-R160 medium 2/3] Guarded, three-state — see
      // `preflightResumeTranscript`'s own doc comment (agent-launch-admission-support.ts).
      const preflight = await preflightResumeTranscript(resolveResumeTranscript, agentType, x)
      if (!preflight.ok) {
        return unrecorded(preflight.reasonCode)
      }
      const recorded = db.recordLaunch({
        hostId: ctx.hostId,
        paneKey,
        agentType,
        sessionId: x,
        launchGeneration: ctx.launchGeneration,
        executionHostId: ctx.executionHostId,
        evidence: 'caller_resume'
      })
      // [S10-21c B3c, D-R151 HIGH, chair ruling 21c-E2] `current_sessions` has no liveness test:
      // the UNIQUE(host_id, session_id) collision this arm sees fires for ANY pane that has ever
      // recorded X, dead panes included — on this box, 6 of 8 rows name panes whose tab no longer
      // exists. A hard refusal here throws (LaunchAdmissionRefusedError), which
      // `spawnWithLane` does not catch, so `provider.spawn` never runs — regressing a launch the
      // base performed for the common "resume my old conversation in a new pane" recovery. The
      // fence INV-P-022's amendment protects (a session another pane currently holds is refused,
      // never SUPERSEDED) is fully served by not recording: no row, no current_sessions move, X
      // stays pointed at its original holder. `unrecorded` is still LOUD — launch_unrecorded
      // audit row plus the pane notice — it just lets the spawn proceed instead of failing it.
      // Scoping this to a genuinely LIVE holder is deferred to R84 (next train).
      if (!recorded.ok) {
        return unrecorded('resume_target_owned_by_another_pane')
      }
      // [S10-21c B3b, D-R149 MEDIUM 1] The same contested-lineage signal SELF_RESUME(caller)
      // raises above (:326) — this arm writes to the pane too, and a registered chair's pane
      // changing its recorded session needs the same trace. Fires regardless of `restated`: the
      // write happened either way.
      // [S10-21c B-final F5, D-R159 finding 5] A DERIVED registered row (`derived === 1`) gets
      // NO trace at all from the branch below — the contested-lineage signal is fenced on
      // non-derived rows only (OD-H: S3 applies no registration predicate by design, but THIS
      // admission surface still must not supersede a derived row's recorded session silently).
      // A distinct outcome, never `contestedLineage` (which is reserved for the non-derived,
      // registered-owner signal), so a supersession here is never traceless either way.
      if (registeredRow !== undefined && registeredRow.derived === 0) {
        ctx.contestedLineage(paneKey, registeredRow.pane_key ?? paneKey, registeredRow.id)
      } else if (registeredRow !== undefined) {
        audit(db, paneKey, ctx.hostId, 'launch_recorded', 'admitted', 'derived_row_superseded')
      }
      // [forced deviation from HOST_MINTED's shape, deliberate] HOST_MINTED/HOST_RESUME notice
      // BEFORE their `recordLaunch`; this notices AFTER it, so a refused resume never emits a
      // notice claiming a resume that did not happen.
      ctx.notice(paneKey, 'launch_caller_resume', 'launch_caller_resume')
      // [D-R104 F-12] A restated row is not this call's to confirm/compensate over. Not reachable
      // from here (a restatement needs this pane's newest row to already BE X, which the
      // SELF_RESUME arm above consumed under the same pane lock) — handled because the typed
      // result carries it, never because it is expected.
      if (recorded.restated) {
        return passThrough(spawnOptions)
      }
      return buildRecordedAdmission(db, ctx, paneKey, recorded.row.seq, spawnOptions)
    }

    // effectiveId.kind === 'none': no selector.
    if (!covered) {
      return unrecorded('sniffed_no_lineage')
    }
    // [S10-21c B3, design §2 S2] The `owned` early return that used to sit here
    // (`if (owned) return unrecorded('pane_key_owned')`) is DELETED: a covered, selector-free
    // launch into a pane that already has a launch row (or a non-derived registered row) is that
    // pane's OWN relaunch, and dropping it is what pinned every pane on this box to its first,
    // often stub, session id (R1). It now takes HOST_MINTED below, owned or not. This never
    // admitted the launch — `unrecorded` passed the spawn through too; it only decided whether
    // the host wrote down what it had already agreed to run. The pane-takeover fence is two
    // layers earlier and independent of this boolean: `createTerminal`'s E1
    // (`assertPaneKeyNotOwned`, orca-runtime.ts:13768-13793, called at :28357) and E2
    // (:28409-28410, adding `assertLeafNotOccupied`) refuse every PLACED create onto a registered
    // or occupied pane before admission runs at all.
    // [S10-21c B3c, D-R151 MEDIUM 1] QUALIFIER: E1 fences NON-DERIVED, NON-QUARANTINED
    // REGISTERED rows only (orca-runtime.ts:13780 returns early for derived-or-quarantined rows)
    // — the renderer's `pty:spawn` path runs no ownership fence at all (its ownership consult is
    // explicitly audit-only, never a refusal, per pty.ts). This fence protects the covered-launch
    // population it was built for; it is not a universal takeover guard.
    // [S10-21c B3, design §2 S2 ADDENDUM] With that early return gone, a host-resume admission
    // that reaches this arm has lost its `--resume <id>` outright and would MINT a fresh session
    // for a restore — turning the restore into a brand-new empty conversation and recording it as
    // the pane's newest, destroying the pointer to the real one. Same condition and same reason
    // code as B2's `undeterminable` arm above (the selector is gone either way).
    if (admission.kind === 'host-resume') {
      return refuse('restore_selector_lost')
    }

    // HOST_MINTED
    // [S10-21a C7f, D-R114 fix 2] Minted-shaped notice — distinct reason code from
    // launch_host_resume so a renderer consumer can tell "keep sleeping" from "clear it".
    ctx.notice(paneKey, 'launch_host_minted', 'launch_host_minted')
    const sessionId = randomUUID()
    const spliced = spliceHostMintedSessionId(channelResolution.subject, sessionId, shell)
    if (!spliced.ok) {
      return unrecorded('launch_command_unlocatable')
    }
    const nextSpawnOptions: PtySpawnOptions =
      channelResolution.channel === 'env'
        ? {
            ...spawnOptions,
            env: {
              ...spawnOptions.env,
              [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: spliced.command
            }
          }
        : { ...spawnOptions, command: spliced.command }

    const params: RecordLaunchParams = {
      hostId: ctx.hostId,
      paneKey,
      agentType: spawnOptions.launchAgent ?? 'claude',
      sessionId,
      launchGeneration: ctx.launchGeneration,
      executionHostId: ctx.executionHostId,
      evidence: 'host_launch'
    }
    const result = db.recordLaunch(params)
    if (!result.ok) {
      return refuse('launch_record_write_failed')
    }
    // [S10-21c B3b, D-R149 MEDIUM 1] Same signal as the caller_resume arm above and
    // SELF_RESUME(caller) (:326): this arm now writes to a registered chair's pane too (the
    // `owned` early return that used to sit here is gone, per the comment block above), and
    // without this the only trace that the pane's recorded session changed was the launch row
    // plus a pty text notice — no `agent_audit` row at all.
    // [S10-21c B-final F5, D-R159 finding 5] Same derived-row fix as the caller_resume arm above:
    // a DERIVED registered row gets its own distinct audit outcome instead of silence.
    if (registeredRow !== undefined && registeredRow.derived === 0) {
      ctx.contestedLineage(paneKey, registeredRow.pane_key ?? paneKey, registeredRow.id)
    } else if (registeredRow !== undefined) {
      audit(db, paneKey, ctx.hostId, 'launch_recorded', 'admitted', 'derived_row_superseded')
    }
    // [D-R104 F-12] A restated row is not this call's to confirm/compensate over.
    if (result.restated) {
      return passThrough(nextSpawnOptions, 'host_minted')
    }
    return buildRecordedAdmission(db, ctx, paneKey, result.row.seq, nextSpawnOptions, 'host_minted')
  })
}
