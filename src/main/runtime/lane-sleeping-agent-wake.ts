import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { PaneCredentialLane } from './pane-credential-lane-registry'

/**
 * How `worktree.activate`'s wake is partitioned host-side (S9 §2a, blocker 2's pane half).
 *
 * The renderer wake does not reuse the slept pane — it calls `createTab` and then clears the
 * record — so the resumed pane is renderer-minted and carries no binding at all, which under §2a
 * means `shared`: a silent downgrade onto the other developer's credential. Lane-bound records
 * are therefore excluded from it and resumed only through the host create path, which mints the
 * paneKey and binds the lane before spawning. A caller the ownership predicate rejects leaves the
 * record ASLEEP (`wake_refused_not_owned`) rather than resuming it on anyone's credential.
 */
export type LaneSleepingWakePartition = {
  /** Every lane-bound pane in this worktree — the set the renderer wake is told to skip. */
  withheldPaneKeys: string[]
  /** The subset this caller's principal owns, to resume through the host create path. */
  ownedRecords: SleepingAgentSessionRecord[]
  /** A lane record belonging to someone else stayed asleep. */
  refusedForeign: boolean
}

export function partitionLaneBoundSleepingRecords(input: {
  records: Readonly<Record<string, SleepingAgentSessionRecord>>
  worktreeId: string
  laneOf(worktreeId: string, paneKey: string): PaneCredentialLane | null
  /** The person behind the caller's grant, or null for an anonymous/unbound caller. */
  callerPrincipalId: string | null
}): LaneSleepingWakePartition {
  const partition: LaneSleepingWakePartition = {
    withheldPaneKeys: [],
    ownedRecords: [],
    refusedForeign: false
  }
  for (const record of Object.values(input.records)) {
    if (record.worktreeId !== input.worktreeId) {
      continue
    }
    const lane = input.laneOf(record.worktreeId, record.paneKey)
    if (lane?.kind !== 'principal') {
      continue
    }
    partition.withheldPaneKeys.push(record.paneKey)
    // Why an equality and not a truthiness check: a caller with NO principal owns nothing, so an
    // anonymous local socket must not be able to resume a lane record by having no identity.
    if (input.callerPrincipalId !== null && lane.principalId === input.callerPrincipalId) {
      partition.ownedRecords.push(record)
    } else {
      partition.refusedForeign = true
    }
  }
  return partition
}

/**
 * The wake's OWNER half: the request that resumes one lane-bound record (S9 §2a).
 *
 * `ensureAgentSession` is the host create path — it resolves the caller's own lane, refuses a
 * lane launch whose args would repoint credential resolution, drops the host-wide
 * `agentDefaultArgs` / `agentDefaultEnv` / `agentCmdOverrides` a peer may have written, and
 * reaches `createTerminal` with the lane, which mints the paneKey and binds it before the spawn.
 * The renderer builder is never asked, so no second tab appears beside the resumed one.
 */
export function buildLaneWakeAgentSessionRequest(
  record: SleepingAgentSessionRecord,
  worktreeId: string
): RuntimeEnsureAgentSessionRequest {
  return {
    kind: 'explicit',
    worktree: `id:${worktreeId}`,
    agent: record.agent,
    providerSession: record.providerSession,
    ...(record.launchConfig ? { agentArgs: record.launchConfig.agentArgs } : {}),
    ...(record.launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: record.launchConfig.ompResumeFilePath }
      : {}),
    presentation: 'background'
  }
}

export type LaneSleepingWakeResumeDeps = {
  resume(request: RuntimeEnsureAgentSessionRequest): Promise<unknown>
  /** Consumed: the host resumed this record, so the renderer must not wake it again. */
  clearRecord(paneKey: string): void
  flush(): Promise<void>
}

/** Resumes each owned record through the host path; returns how many actually came back. */
export async function resumeLaneBoundSleepingRecords(
  records: readonly SleepingAgentSessionRecord[],
  worktreeId: string,
  deps: LaneSleepingWakeResumeDeps
): Promise<number> {
  let resumed = 0
  for (const record of records) {
    try {
      await deps.resume(buildLaneWakeAgentSessionRequest(record, worktreeId))
    } catch (error) {
      // Why swallowed per record: one unresumable agent must not withhold the others, and the
      // record stays asleep so the next activate retries it.
      console.warn('[lane-wake] failed to resume a lane-bound agent session:', error)
      continue
    }
    deps.clearRecord(record.paneKey)
    resumed += 1
  }
  if (resumed > 0) {
    await deps.flush()
  }
  return resumed
}

/**
 * The record map without one pane's entry, or `null` when there is nothing to clear.
 *
 * `null` rather than an unchanged copy so the caller writes the session back only on a real
 * change — and the worktree equality is checked here because a stale record naming another
 * worktree must not be dropped by this worktree's wake.
 */
export function withoutSleepingAgentRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  paneKey: string,
  belongsToWorktree: (record: SleepingAgentSessionRecord) => boolean
): Record<string, SleepingAgentSessionRecord> | null {
  const record = records?.[paneKey]
  if (!records || !record || !belongsToWorktree(record)) {
    return null
  }
  const next = { ...records }
  delete next[paneKey]
  return next
}
