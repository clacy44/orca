// S10-22a WAVE 2 (b1-slice1-succession.md §"Wave 2 contract"): the RPC surface —
// `orchestration.chairs.succeed` / `successionAccept` / `resumeContext`. `succeed` (the
// incumbent, already a registered agent) still uses `resolveCallerAgent`. `successionAccept` and
// `resumeContext` do NOT — G1 repair B1: a freshly `createAgentSession`-spawned pane has no
// `agents` row yet (rows are minted only by `register`/derived upkeep), so `resolveCallerAgent`
// would throw `no_registered_identity` for the exact pane the whole protocol depends on being
// able to call these methods. Both attest by PANE ALONE, the same
// `verifyOrchestrationCompatibilityCaller` primitive `orchestration.agents.register` itself uses.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, OptionalBoolean } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor } from './agent-directory-rpc-view'
import { resolveCallerAgent, NO_PANE_IDENTITY_NEXT_STEPS } from './orchestration-caller-identity'
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
  readResumeContextText
} from '../../orchestration/chair-succession-resume-context'

// G1 repair B5: enforced at the RPC boundary, before `successionId` ever reaches a path.join —
// a successful match is also exactly `generateSuccessionId()`'s own output shape
// (chair-succession-store.ts), so nothing legitimate is ever refused.
const SUCCESSION_ID_RE = /^succ_[0-9a-f]{12}$/

function requireSuccessionId(id: string | undefined): string {
  if (!id || !SUCCESSION_ID_RE.test(id)) {
    throw new OrchestrationError('invalid_argument', '--id must look like succ_<12 hex chars>.')
  }
  return id
}

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
      const successionId = requireSuccessionId(params.successionId)
      // G1 repair B1: pane-only attestation — the successor pane has no `agents` row yet.
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      if (!authority) {
        throw new OrchestrationError(
          'no_pane_identity',
          'This command must run inside a live, attested Orca terminal.',
          { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
        )
      }
      const db = runtime.getOrchestrationDb()
      const deps = depsFor(runtime)
      const hostId = hostIdFor(runtime)
      // The pane's own launch row already carries the host-minted session id `createAgentSession`
      // recorded when it spawned this pane — that IS the "arrives from the new pane with its
      // host-minted session id" proof (D-R215 §Protocol step 5): the caller is attested ON this
      // pane, so the pane's recorded session id is unforgeable by a different process.
      const callerSessionId = db.newestLaunchForPane(hostId, authority.paneKey)?.session_id ?? null
      return acceptSuccession(deps, {
        successionId,
        callerPaneKey: authority.paneKey,
        callerTerminalHandle: authority.terminalHandle,
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
      // G1 repair B1: pane-only attestation, same reasoning as successionAccept above — the
      // SessionStart hook fires before `register` has ever run for this pane.
      const authority = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence,
        { currentRuntimeLaunchSufficient: true }
      )
      if (!authority) {
        throw new OrchestrationError(
          'no_pane_identity',
          'This command must run inside a live, attested Orca terminal.',
          { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
        )
      }
      const db = runtime.getOrchestrationDb()
      const deps = depsFor(runtime)
      // G1 repair M3 (D-R219): hook mode ALWAYS resolves by the caller's own pane, regardless of
      // any `successionId` param; by-id lookup is served ONLY to that record's own successor
      // pane — never to an arbitrary registered pane (the lane's own test previously asserted
      // the opposite, the bug this closes).
      const meta = params.hook
        ? await findSuccessionForSuccessorPane(deps, authority.paneKey)
        : params.successionId
          ? await findSuccessionById(deps, requireSuccessionId(params.successionId))
          : await findSuccessionForSuccessorPane(deps, authority.paneKey)
      if (
        !meta ||
        (!params.hook && params.successionId && meta.successor.paneKey !== authority.paneKey)
      ) {
        return { ok: false, code: 'succession_none' }
      }
      const text = await readResumeContextText(deps, meta)
      if (params.hook) {
        db.writeAgentAudit({
          agentId: db.getAgentByPaneKey(hostIdFor(runtime), authority.paneKey)?.id ?? null,
          actorPaneKey: authority.paneKey,
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
