// S10-22a WAVE 2 (b1-slice1-succession.md §"Wave 2 contract"; D-R215 §Protocol step 3): the seal
// half of the succession state machine — every typed refusal, checkpoint/charter validation, the
// unacked-delivery gate, and the sealed-directory write. The launch/hold/abort half lives in
// chair-succession-hold.ts; the accept/confirm half in chair-succession-accept.ts (split to stay
// under this repo's per-file line ratchet).
import { createHash } from 'node:crypto'
import { readFile, access } from 'node:fs/promises'
import type { OrchestrationDb } from './db'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'
import { parseChairCheckpoint } from './chair-checkpoint'
import { renderResumeContext } from './chair-resume-context'
import {
  createSealed,
  generateSuccessionId,
  listActive,
  SuccessionInFlightError,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { CharterMode, SuccessionMeta, SuccessionReason } from './chair-succession-types'
import {
  readManifestEntry,
  type ManifestEntryWithSuccession
} from './chair-succession-manifest-entry'
import { buildResumeContextInput } from './chair-succession-resume-input'

export type ChairSuccessionDeps = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  orcaHome: string
  manifestPath?: string
}

export function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

function refuse(code: string, message: string, data?: unknown): never {
  throw new OrchestrationError(code, message, data)
}

export type SealParams = {
  callerAgentId: string
  chairName: string
  paneKey: string
  terminalHandle: string
  hostId: string
  checkpointPath: string
  checkpointSha256: string
  reason: SuccessionReason
  ack?: string[]
}

export type SealResult = { meta: SuccessionMeta; entry: ManifestEntryWithSuccession }

/** D-R215 §Protocol step 3. Throws `OrchestrationError` for every typed refusal in the Wave 2
 * contract's fixed order (not_a_chair → no_run → legacy_run → active_dispatch → in_flight →
 * charter_missing → checkpoint_* → unacked_delivery); writes the sealed directory (wave 1's
 * `createSealed`) only once every check passes. Does NOT launch the successor — chair review
 * fix #1: the RPC caller must register the hold (`holdSealRequest`, chair-succession-hold.ts)
 * BEFORE calling `launchSuccessor`, or a launch that fails synchronously-fast calls `settleHold`
 * before the hold exists and the settle is lost (the incumbent then waits out the full 150 s for
 * an outcome that was already known). */
export async function sealSuccession(
  deps: ChairSuccessionDeps,
  params: SealParams
): Promise<SealResult> {
  const entry = await readManifestEntry(deps.manifestPath, params.chairName)

  // `getCurrentRunForPane` filters `legacy = 0` internally (db.ts's `runsBoundToPane`), so it
  // cannot distinguish "no Run at all" from "bound, but legacy" — the two refusals this contract
  // requires distinctly. `listRuns` is unfiltered; scoped to this pane here instead.
  const boundRuns = deps.db.listRuns().runs.filter((r) => r.coordinator_pane_key === params.paneKey)
  if (boundRuns.length === 0) {
    refuse('succession_no_run', 'No Run is bound to this pane; succession requires a bound Run.')
  }
  const run = boundRuns.find((r) => r.legacy === 0)
  if (!run) {
    refuse('succession_legacy_run', 'This pane is bound to a legacy Run.')
  }

  // G1 repair M8 / D-R215 A9: slice 1 never launches onto a named lane — refuse to seal an
  // incumbent that is not itself on the host default lane (a named lane's launch would silently
  // land on the default lane instead, contradicting the rendered context).
  if (deps.runtime.credentialLaneOfPaneKey(params.paneKey) !== null) {
    refuse(
      'succession_lane_unsupported',
      'This pane is on a named credential lane; chair succession (slice 1) only supports the host default lane.'
    )
  }

  const activeDispatch = deps.db.getActiveDispatchForIdentity(params.terminalHandle, params.paneKey)
  const remoteAttachment = deps.db.findActiveRemoteAttachmentForPane(params.paneKey)
  // Chair review fix #2: filtered to the task's own ACTIVE states (TaskStatus, types.ts:26 —
  // 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'; 'pending'/'dispatched'
  // are the two an assignee can still be working). Without this, a chair that ever dispatched a
  // now-finished task was refused forever (`dispatch_id`/`assignee_handle` alone don't age out).
  const leadsTeam = deps.db
    .listTasksWithDispatch({ runId: run.id })
    .some(
      (t) => (t.status === 'pending' || t.status === 'dispatched') && t.assignee_handle !== null
    )
  if (activeDispatch || remoteAttachment || leadsTeam) {
    refuse(
      'succession_active_dispatch',
      'This pane holds an active dispatch, a remote attachment, or leads an active dispatch — finish or hand it off before succeeding.'
    )
  }

  const active = await listActive(storeDepsFor(deps), params.chairName)
  if (active.length > 0) {
    refuse('succession_in_flight', `A succession is already ${active[0].state} for this chair.`, {
      successionId: active[0].id,
      state: active[0].state
    })
  }

  const succ = entry.succession
  if (!succ || succ.enabled !== true || !succ.charterPath) {
    refuse(
      'succession_charter_missing',
      'The manifest has no succession.charterPath configured for this chair.'
    )
  }
  try {
    await access(succ.charterPath)
  } catch {
    refuse('succession_charter_missing', `Charter not found at ${succ.charterPath}.`)
  }
  const charterMode: CharterMode = succ.charterMode ?? 'reference'
  const charterText = await readFile(succ.charterPath, 'utf8')
  const charterSha = createHash('sha256').update(charterText, 'utf8').digest('hex')

  let checkpointText: string
  try {
    checkpointText = await readFile(params.checkpointPath, 'utf8')
  } catch (err) {
    refuse(
      'checkpoint_schema',
      `Cannot read checkpoint at ${params.checkpointPath}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const actualSha = createHash('sha256').update(checkpointText, 'utf8').digest('hex')
  if (actualSha !== params.checkpointSha256) {
    refuse('checkpoint_changed', 'The checkpoint changed on disk after it was hashed.')
  }
  const parsedCheckpoint = parseChairCheckpoint(checkpointText)
  if (!parsedCheckpoint.ok) {
    refuse(parsedCheckpoint.error.code, parsedCheckpoint.error.reason, {
      line: parsedCheckpoint.error.line
    })
  }

  // Chair review fix #4: read-only accessors (db.ts's `getOutstandingMailboxDelivery`/
  // `getOutstandingRunDelivery`, added beside `hasParkedDelivery`, orca-runtime.ts:36858) — the
  // mint-or-read `getOrCreate*` pair has a real side effect on THIS refusal path:
  // `getOrCreateRunDelivery` ignores any `messageIds` (it has no such param — it queries unread
  // run messages itself) and mints a fresh delivery from whatever is unread, even when seal is
  // about to refuse on it. Never call the minting pair from seal.
  const ack = new Set(params.ack ?? [])
  const agentMailbox = `agent:${params.callerAgentId}`
  const agentDelivery = deps.db.getOutstandingMailboxDelivery(agentMailbox)
  const runDelivery = deps.db.getOutstandingRunDelivery(run.id)
  // G1 repair L4: an id in --ack that names no real outstanding delivery is a caller error, not a
  // silent no-op — refuse before the unacked check so a typo'd id cannot masquerade as coverage.
  const knownDeliveryIds = new Set(
    [agentDelivery?.id, runDelivery?.id].filter((id): id is string => id !== undefined)
  )
  const unknownAck = [...ack].filter((id) => !knownDeliveryIds.has(id))
  if (unknownAck.length > 0) {
    refuse('succession_unknown_ack', '--ack named an id with no outstanding delivery.', {
      ids: unknownAck
    })
  }
  const unacked = [agentDelivery?.id, runDelivery?.id].filter(
    (id): id is string => id !== undefined && !ack.has(id)
  )
  if (unacked.length > 0) {
    refuse('succession_unacked_delivery', 'Outstanding delivery not covered by --ack.', {
      ids: unacked
    })
  }

  // G1 repair M1: the size-checked render happens BEFORE any mutation (the ack acknowledgements
  // below, `createSealed`'s disk write) — a `resume_context_too_large` refusal must never leave
  // an acked-but-unsealed delivery or a sealed directory behind. The id is minted here (not left
  // to `createSealed`) so the render uses the REAL id and is never redone.
  const successionId = generateSuccessionId()
  const input = await buildResumeContextInput(
    { db: deps.db, runtime: deps.runtime, storeDeps: storeDepsFor(deps) },
    {
      successionId,
      hostId: params.hostId,
      chairName: params.chairName,
      agentId: params.callerAgentId,
      terminalHandle: params.terminalHandle,
      paneKey: params.paneKey,
      runId: run.id,
      generation: run.consumer_generation,
      worktree: entry.worktree,
      charterPath: succ.charterPath,
      charterSha,
      charterMode,
      ...(charterMode === 'embed' ? { charterText } : {}),
      ackedDeliveryIds: [...ack],
      checkpointText,
      checkpointSha: actualSha
    }
  )
  const rendered = renderResumeContext(input)
  if (!rendered.ok) {
    refuse(rendered.error.code, rendered.error.reason)
  }

  if (agentDelivery && ack.has(agentDelivery.id)) {
    deps.db.acknowledgeMailboxDelivery(agentDelivery.id, agentMailbox)
  }
  if (runDelivery && ack.has(runDelivery.id)) {
    deps.db.acknowledgeRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      deliveryId: runDelivery.id
    })
  }

  let meta: SuccessionMeta
  try {
    meta = await createSealed(storeDepsFor(deps), params.chairName, {
      id: successionId,
      reason: params.reason,
      checkpointText,
      checkpointSha: actualSha,
      charterPath: succ.charterPath,
      charterSha,
      charterMode,
      ...(charterMode === 'embed' ? { charterText } : {}),
      resumeContextText: rendered.text,
      incumbent: { paneKey: params.paneKey, terminalHandle: params.terminalHandle },
      ackedDeliveryIds: [...ack],
      runId: run.id
    })
  } catch (err) {
    // G1 repair M2: the in-lock re-check inside `createSealed` — the ack mutations above already
    // ran, but nothing was sealed/launched under the stale id, and the ORIGINAL in-flight record
    // (surfaced here) is untouched, so retrying `--ack` against IT is safe.
    if (err instanceof SuccessionInFlightError) {
      refuse('succession_in_flight', `A succession is already ${err.state} for this chair.`, {
        successionId: err.successionId,
        state: err.state
      })
    }
    throw err
  }

  deps.db.writeAgentAudit({
    agentId: params.callerAgentId,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: 'succession_seal',
    outcome: 'sealed',
    reasonCode: `succession=${meta.id} reason=${params.reason}`.slice(0, 200)
  })

  // Launch is the RPC caller's job now (fix #1) — see this function's own doc comment.
  return { meta, entry }
}
