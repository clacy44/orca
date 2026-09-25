// S10-22a WAVE 2 (b1-slice1-succession.md §"Wave 2 contract"): the RPC surface —
// `orchestration.chairs.succeed` / `successionAccept` / `resumeContext`. Every call carries the
// same attestation evidence the CLI already attaches to orchestration calls (`resolveCallerAgent`,
// orchestration-caller-identity.ts:42 — no new plumbing, per the contract's own instruction).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, OptionalBoolean } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor } from './agent-directory-rpc-view'
import { resolveCallerAgent } from './orchestration-caller-identity'
import { assertLocalCaller } from './chairs-restore'
import {
  sealSuccession,
  type ChairSuccessionDeps
} from '../../orchestration/chair-succession-execute'
import { holdSealRequest, launchSuccessor } from '../../orchestration/chair-succession-hold'
import { acceptSuccession } from '../../orchestration/chair-succession-accept'
import {
  findSuccessionById,
  findSuccessionForSuccessorPane,
  readResumeContextText,
  markResumeContextServed
} from '../../orchestration/chair-succession-resume-context'

function defaultOrcaHome(): string {
  return join(homedir(), '.orca')
}

function depsFor(runtime: Parameters<RpcMethod['handler']>[1]['runtime']): ChairSuccessionDeps {
  const db = runtime.getOrchestrationDb()
  return { db, runtime, orcaHome: defaultOrcaHome() }
}

const SucceedParams = z.object({
  checkpointPath: OptionalString,
  checkpointSha256: OptionalString,
  reason: OptionalString,
  ack: z.array(z.string()).optional()
})

const SuccessionAcceptParams = z.object({
  successionId: OptionalString
})

const ResumeContextParams = z.object({
  successionId: OptionalString,
  hook: OptionalBoolean
})

export const CHAIRS_SUCCESSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.chairs.succeed',
    params: SucceedParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime, orchestrationCompatibilityEvidence, signal } = ctx
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      if (!params.checkpointPath || !params.checkpointSha256) {
        throw new OrchestrationError(
          'invalid_argument',
          '--checkpoint and its sha256 are required.'
        )
      }
      if (params.reason !== 'batch_end' && params.reason !== 'context') {
        throw new OrchestrationError('invalid_argument', '--reason must be batch_end or context.')
      }
      const deps = depsFor(runtime)
      const hostId = hostIdFor(runtime)
      const agentRow = db.getAgentByPaneKey(hostId, caller.pane_key)
      if (!agentRow) {
        throw new OrchestrationError('no_registered_identity', 'This pane has no registered chair.')
      }
      const { meta, entry } = await sealSuccession(deps, {
        callerAgentId: caller.id,
        chairName: agentRow.display_name,
        paneKey: caller.pane_key,
        terminalHandle: caller.terminal_handle ?? '',
        hostId,
        checkpointPath: params.checkpointPath,
        checkpointSha256: params.checkpointSha256,
        reason: params.reason,
        ack: params.ack
      })
      // Chair review fix #1: register the hold BEFORE launching. `holdSealRequest` is `async`
      // with no `await` before its `return new Promise(...)` — calling it (even un-awaited)
      // synchronously runs the executor and inserts the hold entry into `chair-succession-
      // hold.ts`'s module-level map before this line returns. Only THEN start the launch, so a
      // launch that fails on its very first microtask still finds the hold registered when its
      // catch block calls `settleHold` — otherwise that settle is silently lost and the
      // incumbent waits out the full 150 s for an outcome already known.
      const holdPromise = holdSealRequest(deps, hostId, meta, signal)
      void launchSuccessor(deps, hostId, entry, meta)
      // D-R215 §Protocol step 3: HOLDS the request like a parking wait; on confirm it is never
      // actually answered (the pane is closed before this Promise settles — see
      // chair-succession-accept.ts's `settleHold` call for why settling it here is still safe).
      return holdPromise
    }
  }),
  defineMethod({
    name: 'orchestration.chairs.successionAccept',
    params: SuccessionAcceptParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime, orchestrationCompatibilityEvidence } = ctx
      if (!params.successionId) {
        throw new OrchestrationError('invalid_argument', '--id is required.')
      }
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const deps = depsFor(runtime)
      const hostId = hostIdFor(runtime)
      // The pane's own launch row already carries the host-minted session id `createAgentSession`
      // recorded when it spawned this pane — that IS the "arrives from the new pane with its
      // host-minted session id" proof (D-R215 §Protocol step 5): the caller is attested ON this
      // pane, so the pane's recorded session id is unforgeable by a different process.
      const callerSessionId = db.newestLaunchForPane(hostId, caller.pane_key)?.session_id ?? null
      return acceptSuccession(deps, {
        successionId: params.successionId,
        callerPaneKey: caller.pane_key,
        callerTerminalHandle: caller.terminal_handle ?? '',
        callerSessionId,
        hostId
      })
    }
  }),
  defineMethod({
    name: 'orchestration.chairs.resumeContext',
    params: ResumeContextParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime, orchestrationCompatibilityEvidence } = ctx
      const db = runtime.getOrchestrationDb()
      const caller = resolveCallerAgent(db, runtime, orchestrationCompatibilityEvidence)
      const deps = depsFor(runtime)
      const meta = params.successionId
        ? await findSuccessionById(deps, params.successionId)
        : await findSuccessionForSuccessorPane(deps, caller.pane_key)
      if (!meta) {
        return { ok: false, code: 'succession_none' }
      }
      const text = await readResumeContextText(deps, meta)
      if (params.hook) {
        markResumeContextServed(meta.id)
        db.writeAgentAudit({
          agentId: caller.id,
          actorPaneKey: caller.pane_key,
          actorHostId: hostIdFor(runtime),
          verb: 'succession_resume_context',
          outcome: 'served',
          reasonCode: `succession=${meta.id}`.slice(0, 200)
        })
      }
      return { ok: true, text, served: Boolean(params.hook) }
    }
  })
]
