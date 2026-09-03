// Ruling 28(a)/(c)/(e) (C8a): `orchestration.linkBind` — split out of
// orchestration-link-binding-local.ts (max-lines). The operator's single-link kick schedules
// 'operator_bind' (proveNow, never 'inbound_contact' — C7's declared deviation 3), lifts a sticky
// revoke through its own guarded statement BEFORE the round runs, and waits for that round's
// settle so it reports what actually happened rather than a fire-and-forget 'running'.
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLocalCaller } from './orchestration-link-binding-caller-gate'
import { collectLinkIds } from './orchestration-link-binding-ids'
import {
  LINK_BINDING_LEGACY_ATTEST_TTL_MS,
  LINK_BINDING_STATUS_WAIT_CAP_MS
} from '../../orchestration/link-binding-constants'

const LinkBindParams = z
  .object({
    link: z.string().optional(),
    all: z.boolean().optional(),
    deep: z.boolean().optional(),
    acceptLegacy: z.boolean().optional(),
    lift: z.boolean().optional(),
    reason: z.string().optional()
  })
  .strict()

const LINK_BIND_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkBind',
  params: LinkBindParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const { runtime } = ctx
    if (!params.link && !params.all) {
      throw new OrchestrationError('invalid_argument', 'Pass --link <deviceId> or --all.')
    }
    const db = runtime.getOrchestrationDb()
    if (params.link && !collectLinkIds(runtime).includes(params.link)) {
      throw new OrchestrationError('invalid_argument', `No link known for ${params.link}.`)
    }
    if (params.acceptLegacy) {
      if (!params.link) {
        throw new OrchestrationError(
          'invalid_argument',
          '--accept-legacy requires exactly one --link.'
        )
      }
      if (params.lift) {
        // Ruling 28(e)/protocol F3: --lift on link-bind WITHDRAWS the attestation instead of
        // renewing it — the exact inverse of the un-lifted flag, which C7 shipped as dead grammar.
        const prior = db.getContainment('link', params.link, 'accept_legacy')
        db.liftContainment('link', params.link, 'accept_legacy', Date.now())
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: 'local',
          verb: 'linkBinding',
          outcome: 'accept_legacy_lifted',
          reasonCode: JSON.stringify({
            link: params.link,
            priorReasonText: prior?.reasonText ?? null,
            priorExpiresAt: prior?.expiresAt ?? null
          })
        })
      } else {
        if (!params.reason) {
          throw new OrchestrationError(
            'invalid_argument',
            '--accept-legacy requires a --reason (pass --lift to withdraw instead).'
          )
        }
        const binding = db.getPeerLinkBinding(params.link)
        if (!binding) {
          throw new OrchestrationError(
            'invalid_argument',
            `No binding known for link ${params.link}.`
          )
        }
        const now = Date.now()
        const prior = db.getContainment('link', params.link, 'accept_legacy')
        db.putContainment({
          subjectKind: 'link',
          subjectId: params.link,
          action: 'accept_legacy',
          reasonCode: 'operator_attestation',
          reasonText: params.reason,
          detail: JSON.stringify({
            environmentId: binding.environmentId,
            peerKeyFingerprint: binding.peerKeyFingerprint
          }),
          createdAt: now,
          expiresAt: now + LINK_BINDING_LEGACY_ATTEST_TTL_MS
        })
        db.writeAgentAudit({
          agentId: null,
          actorPaneKey: null,
          actorHostId: 'local',
          verb: 'linkBinding',
          outcome: prior && prior.liftedAt === null ? 'accept_legacy_reasserted' : 'accept_legacy',
          reasonCode: JSON.stringify({
            link: params.link,
            reasonText: params.reason,
            priorReasonText: prior?.reasonText ?? null,
            priorExpiresAt: prior?.expiresAt ?? null
          })
        })
      }
    }
    const prover = runtime.getLinkBindingProver()
    if (params.link) {
      // Ruling 28(a): 'operator_bind' is exempt from the peer-traffic kick debounce and the park
      // re-arm debounce, and bypasses the contested/revoked round exclusions.
      const wasRevoked = db.getPeerLinkBinding(params.link)?.revokedAt != null
      if (wasRevoked) {
        // Ruling 28(a): clears a sticky revoke through its OWN guarded statement, audited, BEFORE
        // the round runs — `link-bind` is the only path licensed to lift a revoke.
        const now = Date.now()
        if (db.unrevokePeerLinkBinding(params.link, now)) {
          db.writeAgentAudit({
            agentId: null,
            actorPaneKey: null,
            actorHostId: params.link,
            verb: 'linkBinding',
            outcome: 'link_revoke_lifted',
            reasonCode: null
          })
        }
      }
      prover.scheduleBinding(params.link, 'operator_bind')
      if (params.deep) {
        prover.requestRerun('contest_search')
      }
      // Ruling 28(a)/(c): wait for THIS round's settle so the verb reports what actually
      // happened rather than a fire-and-forget 'running' for work it may not have done (a
      // contested/revoked link previously reported 'running' while doing nothing at all).
      const settled = await prover.waitForSettle(params.link, LINK_BINDING_STATUS_WAIT_CAP_MS)
      if (settled === 'timeout') {
        return { state: 'timeout', link: params.link }
      }
      const binding = db.getPeerLinkBinding(params.link)
      const attempt = db.getBindingAttempt(params.link)
      const state =
        binding?.state === 'contested' ? 'contested' : (attempt?.lastOutcome ?? 'unavailable')
      return { state, link: params.link, attemptId: `${params.link}:${Date.now()}` }
    }
    const ids = collectLinkIds(runtime)
    for (const linkDeviceId of ids) {
      prover.scheduleBinding(linkDeviceId, 'operator_bind')
    }
    if (params.deep) {
      prover.requestRerun('contest_search')
    }
    return { state: 'running', kicked: ids }
  }
})

export const ORCHESTRATION_LINK_BINDING_BIND_METHODS: RpcMethod[] = [LINK_BIND_METHOD]
