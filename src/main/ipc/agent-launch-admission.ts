// S10-21a C3-v2 (errata 5(p) v2.1 §B, §C.1-§C.4, §C.6, §G): the one launch-admission point.
// `spawnWithLane` (lane-pinned-spawn.ts) calls `admitAgentLaunch` between the lane computation
// and the provider call, inside the (hostId, paneKey) lock; `confirmAdmittedLaunch` /
// `compensateAdmittedLaunch` run after/on-throw. This module never touches the restore-ticket
// registry (C2) or the pane-key gate (C3a-v2) — it consumes what its caller already redeemed.
// Split across agent-launch-classification.ts (pure token scanners) and
// agent-launch-admission-lock.ts (the (host,pane) mutex) to stay under the max-lines budget.
import { randomUUID } from 'node:crypto'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import { spliceHostMintedSessionId } from '../../shared/agent-resume-launch-command'
import { isCoveredLaunchAgent } from '../../shared/covered-launch-agents'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { RecordLaunchParams } from '../runtime/orchestration/agent-launch-sessions'
// [JUDGMENT CALL, see RETURN] `OrchestrationDb` (db.ts), not the raw `Database.Database` the
// store module (agent-launch-sessions.ts) takes: `OrchestrationDb.db` is private with no public
// accessor, so a pty.ts call site — which only ever holds `runtime.getOrchestrationDb()` — cannot
// obtain a raw handle. Every store call below goes through OrchestrationDb's existing public
// delegate methods (recordLaunch/newestLaunchForPane/getAgentByPaneKey/writeAgentAudit, plus the
// deleteLaunchRow delegate this commit adds to db.ts — the only one that was missing).
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { LaunchAdmissionRefusedError } from './agent-launch-admission-errors'
import { withPaneLock } from './agent-launch-admission-lock'
import { audit, passThrough, type AdmittedLaunch } from './agent-launch-admission-support'
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
 * (`agent-launch-admission-import-boundary.test.ts`) asserts no rpc/ipc-schema/relay/renderer
 * module names 'host-resume'. */
export type LaunchAdmission =
  | { kind: 'caller'; sequencedAgentLine?: string }
  | {
      kind: 'host-resume'
      sessionId: string
      predecessorPaneKey: string
      executionHostId: string
      launchGeneration: string
      launchSeq?: number
      sequencedAgentLine?: string
    }

export type AgentLaunchAdmissionContext = {
  hostId: string
  executionHostId: string
  launchGeneration: string
  /** [§2.6] Raised on SELF_RESUME(caller) into a registered pane and on every UNRECORDED. */
  notice?: (paneKey: string, verb: string, reasonCode: string) => void
  /** [§C.4 SELF_RESUME v2.1 V1] The §2.6 contested-lineage signal. If the real helper (C6) does
   * not exist yet, callers may omit this — the audit row and notice still fire; nothing swallows
   * the signal, it is simply not yet wired to C6's consumer. */
  contestedLineage?: (paneKey: string) => void
}

export type { AdmittedLaunch } from './agent-launch-admission-support'

/** [errata 5(p) v2.1 §C.1-§C.4] The one launch-admission point. Called from `spawnWithLane`
 * between the lane computation and `provider.spawn`, inside the (hostId, paneKey) lock.
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
    ctx.notice?.(paneKey, 'launch_unrecorded', reasonCode)
    return passThrough(spawnOptions)
  }
  const refuse = (reasonCode: string): never => {
    audit(db, paneKey, ctx.hostId, 'launch_refused', 'refused', reasonCode)
    throw new LaunchAdmissionRefusedError(reasonCode)
  }

  if (!channelResolution.ok) {
    return unrecorded(channelResolution.reason)
  }
  // [§C.2 deliverability] `commandDelivery === 'renderer'` is terminal-paste — the only shape a
  // remote provider can receive without itself running `subject` (T50 pins this to zero
  // production writers, so this branch is defence, not the common case).
  if (spawnOptions.commandDelivery === 'renderer') {
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
    const owned =
      newestRow !== undefined || (registeredRow !== undefined && registeredRow.derived === 0)

    // [§C.4 "--continue ruled"] id-less/undeterminable resolution.
    if (effectiveId.kind === 'undeterminable') {
      return unrecorded(owned ? 'pane_key_owned' : 'resume_target_undeterminable')
    }

    if (effectiveId.kind === 'id') {
      const x = effectiveId.sessionId
      if (admission.kind === 'host-resume' && admission.sessionId === x) {
        // HOST_RESUME
        const params: RecordLaunchParams = {
          hostId: ctx.hostId,
          paneKey,
          agentType: spawnOptions.launchAgent ?? 'claude',
          sessionId: x,
          launchGeneration: admission.launchGeneration,
          executionHostId: admission.executionHostId,
          evidence: 'sweep_record',
          supersedePaneKey: admission.predecessorPaneKey
        }
        const result = db.recordLaunch(params)
        if (!result.ok) {
          return refuse('launch_record_write_failed')
        }
        return passThrough(spawnOptions)
      }
      if (newestRow !== undefined && newestRow.session_id === x) {
        // SELF_RESUME — [v2.1 V1] ALWAYS audited, no row, no splice.
        const reasonCode = admission.kind === 'host-resume' ? 'host' : 'caller'
        audit(db, paneKey, ctx.hostId, 'launch_self_resume', 'admitted', reasonCode)
        if (reasonCode === 'caller' && registeredRow !== undefined && registeredRow.derived === 0) {
          ctx.notice?.(paneKey, 'launch_self_resume', 'caller')
          ctx.contestedLineage?.(paneKey)
        }
        return passThrough(spawnOptions)
      }
      return unrecorded(owned ? 'pane_key_owned' : 'foreign_selector')
    }

    // effectiveId.kind === 'none': no selector.
    if (!covered) {
      return unrecorded('sniffed_no_lineage')
    }
    if (owned) {
      return unrecorded('pane_key_owned')
    }

    // HOST_MINTED
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
    const seq = result.row.seq
    let settled = false
    return {
      spawnOptions: nextSpawnOptions,
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
            audit(db, paneKey, ctx.hostId, 'launch_surface_diverged', 'compensated', null)
            ctx.notice?.(paneKey, 'launch_surface_diverged', 'launch_surface_diverged')
          }
        }
      },
      compensate: (fromEnsureFailure?: boolean) => {
        if (settled) {
          return
        }
        settled = true
        if (fromEnsureFailure) {
          // [§C.6] The process may still be alive: never destroy a fact not proven false.
          audit(db, paneKey, ctx.hostId, 'launch_ensure_failed_after_spawn', 'compensated', null)
          return
        }
        db.deleteLaunchRow(seq)
        audit(db, paneKey, ctx.hostId, 'launch_spawn_failed', 'compensated', null)
      }
    }
  })
}
