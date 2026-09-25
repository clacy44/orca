// S10-22a WAVE 2 (D-R215 §Protocol steps 5/6): `orchestration.chairs.successionAccept`'s whole
// body — proving the successor, then the confirm ("Act") tail: close the incumbent, the EXISTING
// dead-pane takeover, `bindRun` + waiter cancel, the retired handle, the manifest write, and
// releasing the incumbent's held `succeed` call (never actually answered — its pane is dead by
// the time this returns).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  transition,
  appendRetiredHandle,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import { OrchestrationError } from './orchestration-error'
import { registerAgentForPane } from './register-agent-for-pane'
import { withPaneLock } from '../../ipc/agent-launch-admission-lock'
import { parseChairsManifest, type ChairsManifest } from './chairs-manifest'
import { writeFileAtomic, pathExists } from '../rpc/methods/chairs-restore'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { defaultChairsManifestPath } from './chair-succession-manifest-entry'
import { findSuccessionById, wasResumeContextServed } from './chair-succession-resume-context'
import { settleHold } from './chair-succession-hold'
import { refreshRetiredHandlesIndexSync } from './chair-succession-retired-index'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

const ACCEPT_LAUNCHING_MAX_AGE_MS = 150_000

export type AcceptParams = {
  successionId: string
  callerPaneKey: string
  callerTerminalHandle: string
  callerSessionId: string | null
  hostId: string
}

export type AcceptObligations = {
  ackedDeliveryIds: string[]
  outstandingDeliveryIds: string[]
  retiredHandle: string | null
  /** Slice 1: peer-question threads are not tracked by succession yet — always empty. */
  pendingPeerQuestionThreadIds: string[]
  /** Slice 1: pact turn-holding is not tracked by succession yet — always 0. */
  pactTurnsHeld: number
}

export type AcceptResult = {
  ok: true
  successionId: string
  chair: string
  agentId: string
  runId: string
  generation: number
  resumeContext?: string
  obligations: AcceptObligations
}

/** D-R215 §Protocol step 5 "the successor's accept call must arrive from the new pane with its
 * host-minted session id" + step 6 (Act). Every refusal below is thrown BEFORE any effect —
 * `succession_wrong_pane`/`succession_not_launching`/`succession_expired` never mutate anything. */
export async function acceptSuccession(
  deps: ChairSuccessionDeps,
  params: AcceptParams
): Promise<AcceptResult> {
  const meta = await findSuccessionById(deps, params.successionId)
  if (!meta) {
    throw new OrchestrationError('succession_unknown', `No succession ${params.successionId}.`)
  }
  if (meta.state !== 'launching') {
    throw new OrchestrationError(
      'succession_not_launching',
      `Succession ${params.successionId} is ${meta.state}, not launching.`
    )
  }
  if (meta.successor.paneKey !== params.callerPaneKey) {
    throw new OrchestrationError(
      'succession_wrong_pane',
      'This succession was not launched onto the calling pane.'
    )
  }
  if (Date.now() - Date.parse(meta.createdAt) > ACCEPT_LAUNCHING_MAX_AGE_MS) {
    throw new OrchestrationError('succession_expired', `Succession ${params.successionId} expired.`)
  }

  // Act (D-R215 §Protocol step 6). Close the incumbent FIRST — the dead-pane takeover below
  // depends on its pane no longer being live.
  try {
    await deps.runtime.closeTerminal(meta.incumbent.terminalHandle)
  } catch {
    // best-effort — the incumbent pane may already be gone (e.g. it crashed mid-hold).
  }

  const run =
    deps.db.getCurrentRunForPane(meta.incumbent.paneKey) ??
    deps.db.getCurrentRunForPane(params.callerPaneKey)

  const registration = await registerAgentForPane(deps.db, deps.runtime, {
    paneKey: params.callerPaneKey,
    terminalHandle: params.callerTerminalHandle,
    processIncarnation: deps.runtime.getTerminalProcessIncarnation(params.callerTerminalHandle),
    displayName: meta.chair,
    role: undefined
  })
  if (!registration.ok) {
    // Chair review fix #3: the incumbent's pane is ALREADY closed at this point — leaving the
    // record `launching` would let the hold's own 150 s timeout later run `runAbortTail`, which
    // closes the SUCCESSOR pane too (both panes dead, unrecoverable). Abort it here instead, so
    // `runAbortTail` later finds it already terminal (`already_terminal`) and leaves the
    // successor pane open for manual recovery (`orca chairs restore`).
    const abortReason = `takeover_failed_after_close:${registration.reason}`.slice(0, 200)
    await transition(storeDepsFor(deps), meta.chair, meta.id, 'aborted', { abortReason })
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: params.callerPaneKey,
      actorHostId: params.hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: `succession=${meta.id} reason=${abortReason}`.slice(0, 200)
    })
    settleHold(meta.id, {
      ok: false,
      code: 'succession_aborted',
      successionId: meta.id,
      reason: 'takeover_failed'
    })
    throw new OrchestrationError(
      'succession_takeover_failed',
      `Dead-pane takeover for chair "${meta.chair}" failed: ${registration.reason}.`
    )
  }

  const runId = run?.id
  if (runId) {
    deps.db.bindRun({
      runId,
      coordinatorHandle: params.callerTerminalHandle,
      coordinatorPaneKey: params.callerPaneKey
    })
    deps.runtime.cancelMessageWaiters(`run:${runId}`)
  }

  await appendRetiredHandle(storeDepsFor(deps), meta.chair, {
    handle: meta.incumbent.terminalHandle,
    succession: meta.id,
    at: new Date().toISOString()
  })
  refreshRetiredHandlesIndexSync(deps.orcaHome)

  const confirmed = await transition(storeDepsFor(deps), meta.chair, meta.id, 'confirmed', {
    retiredHandle: meta.incumbent.terminalHandle
  })

  await writeManifestLastSessionId(
    deps.manifestPath,
    params.hostId,
    meta.chair,
    params.callerSessionId
  )

  deps.db.writeAgentAudit({
    agentId: registration.agent.id,
    actorPaneKey: params.callerPaneKey,
    actorHostId: params.hostId,
    verb: 'succession_confirm',
    outcome: 'confirmed',
    reasonCode: `succession=${meta.id}`.slice(0, 200)
  })

  // Never actually reaches the incumbent (its pane is already closed) — released here only so
  // the held `succeed` Promise doesn't leak forever.
  settleHold(meta.id, { ok: true, confirmed: true, successionId: meta.id })

  const served = wasResumeContextServed(meta.id)
  const resumeContextText = served
    ? undefined
    : await readFile(
        join(deps.orcaHome, 'chairs', meta.chair, 'successions', meta.id, 'resume-context.md'),
        'utf8'
      )

  // S10-22a residual R238: read-only accessors (same pair chair-succession-execute.ts's seal path
  // uses) against the successor's OWN mailbox/run, taken after the takeover above — anything
  // still outstanding here arrived on/after the handoff, so the successor (not the acked-at-seal
  // set) owns it.
  const successorMailbox = `agent:${registration.agent.id}`
  const outstandingMailbox = deps.db.getOutstandingMailboxDelivery(successorMailbox)
  const outstandingRun = runId ? deps.db.getOutstandingRunDelivery(runId) : undefined
  const outstandingDeliveryIds = [outstandingMailbox?.id, outstandingRun?.id].filter(
    (id): id is string => id !== undefined
  )

  const obligations: AcceptObligations = {
    ackedDeliveryIds: meta.ackedDeliveryIds ?? [],
    outstandingDeliveryIds,
    retiredHandle: meta.incumbent.terminalHandle,
    pendingPeerQuestionThreadIds: [],
    pactTurnsHeld: 0
  }

  return {
    ok: true,
    successionId: confirmed.id,
    chair: meta.chair,
    agentId: registration.agent.id,
    runId: runId ?? '',
    generation: runId ? (deps.db.getRun(runId)?.consumer_generation ?? 0) : 0,
    ...(resumeContextText !== undefined ? { resumeContext: resumeContextText } : {}),
    obligations
  }
}

async function writeManifestLastSessionId(
  manifestPath: string | undefined,
  hostId: string,
  chair: string,
  sessionId: string | null
): Promise<void> {
  if (!sessionId) {
    return
  }
  const path = manifestPath ?? defaultChairsManifestPath()
  // [Wave 2 contract A7] restore/export/succession share ONE lock key `chairs-manifest:<host>` on
  // `withPaneLock` — restore itself still takes no lock at all (chairs-restore.ts has no
  // `withPaneLock` call for its own read-modify-write); moving restore onto this key is another
  // worker's slice per the brief's scope split, flagged here rather than done silently.
  await withPaneLock(`chairs-manifest:${hostId}`, async () => {
    if (!(await pathExists(path))) {
      return
    }
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseChairsManifest(parsedJson)
    if (!parsed.ok) {
      return
    }
    const manifest: ChairsManifest = parsed.manifest
    const entry = manifest.chairs.find((c) => c.name === chair)
    if (!entry || entry.lastSessionId === sessionId) {
      return
    }
    entry.lastSessionId = sessionId
    await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
  })
}
