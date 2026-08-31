// S10-3 pact spec RPCS §: orchestration.threads.pact — propose/accept/decline/pause/resume/
// release. Split out of orchestration-threads.ts (that file's line budget could not absorb the
// full pact surface) and off orchestration-pact-step.ts (step/pactLedger) per the max-lines
// ratchet. A2: "S10-3's entire surface is orca agents pact"; one-shot engage is replaced.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveCallerAgent, type ResolvedCallerAgent } from './orchestration-caller-identity'
import { wakePactThread, wakePactThreadBoth, wakeTurnArrived } from './orchestration-pact-wake'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

const PactParams = z.object({
  id: requiredString('Missing --on'),
  with: OptionalString,
  steps: OptionalFiniteNumber,
  open: z.boolean().optional(),
  accept: z.boolean().optional(),
  decline: z.boolean().optional(),
  pause: z.boolean().optional(),
  resume: z.boolean().optional(),
  release: z.boolean().optional(),
  reasonCode: OptionalString
})

function actorOf(caller: ResolvedCallerAgent): {
  callerAgentId: string
  callerPaneKey: string | null
  callerHostId: string
} {
  return { callerAgentId: caller.id, callerPaneKey: caller.pane_key, callerHostId: caller.host_id }
}

export const ORCHESTRATION_PACT_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.threads.pact',
    params: PactParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const actor = actorOf(caller)

      if (params.accept) {
        return handleAccept(db, runtime, actor, params.id)
      }
      if (params.decline) {
        return handleDecline(db, runtime, actor, params.id, params.reasonCode ?? null)
      }
      if (params.pause) {
        return handlePause(db, runtime, actor, params.id, params.reasonCode ?? null)
      }
      if (params.resume) {
        return handleResume(db, runtime, actor, params.id)
      }
      if (params.release) {
        return handleRelease(db, runtime, actor, params.id, params.reasonCode ?? null)
      }
      if (params.with) {
        return handlePropose(db, actor, params.id, params.with, params.steps, params.open)
      }
      throw new OrchestrationError(
        'invalid_argument',
        'orca agents pact needs one of --with, --accept, --decline, --pause, --resume, --release.'
      )
    }
  })
]

function handlePropose(
  db: OrchestrationDb,
  actor: ReturnType<typeof actorOf>,
  threadId: string,
  withParam: string,
  steps: number | undefined,
  open: boolean | undefined
): unknown {
  if (steps !== undefined && open) {
    throw new OrchestrationError('invalid_argument', '--steps and --open are mutually exclusive.')
  }
  const peerId = withParam.startsWith('agent:') ? withParam.slice('agent:'.length) : withParam
  const thread = db.proposePact({
    ...actor,
    threadId,
    peerAgentId: peerId,
    stepsTotal: open ? null : (steps ?? null)
  })
  return {
    thread,
    nextSteps: [
      `orca agents pact --on ${threadId} --accept`,
      `orca agents wait --thread ${threadId} --for pact`
    ]
  }
}

function handleAccept(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  actor: ReturnType<typeof actorOf>,
  threadId: string
): unknown {
  const thread = db.acceptPact({ ...actor, threadId })
  // Turn moves to the proposer (RPCS §): wake its `--for pact` park on this thread first (more
  // specific outcome), then its turn_arrived park on any OTHER thread (A4) — the removal
  // semantics in resolveMessageWaiter make firing both unconditionally safe (K20).
  const nextSteps = [`orca agents wait --thread ${threadId} --for step`]
  wakePactThread(runtime, thread.pact_proposer_agent_id, threadId, 'accepted', nextSteps)
  wakeTurnArrived(runtime, thread.pact_proposer_agent_id, threadId)
  return { thread, nextSteps }
}

function handleDecline(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  actor: ReturnType<typeof actorOf>,
  threadId: string,
  reasonCode: string | null
): unknown {
  const thread = db.declinePact({ ...actor, threadId, reasonCode })
  // Major fix (S10-3b review, K22): every non-message outcome must carry nextSteps — an empty
  // array left the woken proposer's `wait --for pact` print a bare "pact declined." with no
  // `Next:` line (agents-threads.ts's formatWait only prints one when nextSteps is non-empty).
  const nextSteps = [`orca agents pact --show ${threadId}`]
  wakePactThread(runtime, thread.pact_proposer_agent_id, threadId, 'declined', nextSteps)
  return { thread, nextSteps }
}

function handlePause(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  actor: ReturnType<typeof actorOf>,
  threadId: string,
  reasonCode: string | null
): unknown {
  const thread = db.pausePact({ ...actor, threadId, reasonCode })
  const nextSteps = [
    `orca agents pact --resume --on ${threadId}`,
    `orca agents pact --release --on ${threadId}`
  ]
  wakePactThreadBoth(
    runtime,
    threadId,
    [thread.pact_proposer_agent_id, thread.pact_with_agent_id],
    'paused',
    nextSteps
  )
  return { thread, nextSteps }
}

function handleResume(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  actor: ReturnType<typeof actorOf>,
  threadId: string
): unknown {
  const outcome = db.resumePactOrRequest({ ...actor, threadId })
  if (outcome.kind === 'requested') {
    return {
      thread: outcome.thread,
      requested: true,
      nextSteps: [`orca agents pact --resume --on ${threadId}`]
    }
  }
  // Rev 4: resume un-freezes the turn where it already was — a turn holder who parked
  // elsewhere WHILE frozen (K5/K24 excludes a paused pact from getTurnsHeldBy) needs the same
  // turn_arrived wake a fresh transfer gets.
  wakeTurnArrived(runtime, outcome.thread.pact_turn_agent_id, threadId)
  return { thread: outcome.thread, requested: false, nextSteps: [] }
}

function handleRelease(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  actor: ReturnType<typeof actorOf>,
  threadId: string,
  reasonCode: string | null
): unknown {
  const before = db.getPactState(threadId)
  const thread = db.releasePact({ ...actor, threadId, reasonCode })
  const other =
    before?.pact_proposer_agent_id === actor.callerAgentId
      ? before?.pact_with_agent_id
      : before?.pact_proposer_agent_id
  // Major fix (S10-3b review, K22): every non-message outcome must carry nextSteps (same as
  // handleDecline above) — a released pact's woken waiter otherwise prints a bare dead end.
  const nextSteps = [`orca agents pact --show ${threadId}`]
  // Release wakes a parked proposer AND a `--for reply` park on this thread — resolvePactWaiters
  // resolves every for:'pact'|'step'|'reply' waiter of this agent registered on `threadId`
  // uniformly (message-waiter-thread-keying.ts), so one call covers all three.
  wakePactThread(runtime, other ?? null, threadId, 'released', nextSteps)
  return { thread, nextSteps }
}
