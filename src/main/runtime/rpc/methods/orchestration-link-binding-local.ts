// S10-16 C7/C8a, R22 (design v6): the local-operator link-binding surface — `linkBindings`,
// `linkBind`, `linkRevoke`, `linkForget`. `linkContainment` and `replyOutbox` live in their own
// files (orchestration-link-binding-containment.ts / -outbox.ts, C8a max-lines split). Every verb
// opens with the shared local-caller gate (R22, Ruling 28(h): the positive form, R23.4/R30.3:
// never registered on the peer allowlist — test 53).
import { z } from 'zod'
import { defineMethod, type RpcMethod, type RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  describeLinkBindingHealth,
  resolveEnvironmentName
} from '../../orchestration/link-binding-attention'
import {
  readEnvironmentSnapshot,
  getRoutableLinkBinding
} from '../../orchestration/link-binding-routable'
import { renderLinkBindingHealth } from '../../../../shared/link-binding-health'
import { requireLocalCaller } from './orchestration-link-binding-caller-gate'
import { ORCHESTRATION_LINK_BINDING_CONTAINMENT_METHODS } from './orchestration-link-binding-containment'
import { ORCHESTRATION_LINK_BINDING_OUTBOX_METHODS } from './orchestration-link-binding-outbox'
import {
  LINK_BINDING_LEGACY_ATTEST_TTL_MS,
  LINK_BINDING_STATUS_WAIT_CAP_MS
} from '../../orchestration/link-binding-constants'

function collectLinkIds(runtime: RpcContext['runtime']): string[] {
  const db = runtime.getOrchestrationDb()
  const ids = new Set<string>()
  for (const row of db.listPeerLinkBindings()) {
    ids.add(row.linkDeviceId)
  }
  for (const row of db.listBindingAttempts()) {
    ids.add(row.linkDeviceId)
  }
  for (const row of db.listContainment()) {
    if (row.subjectKind === 'link') {
      ids.add(row.subjectId)
    }
  }
  // Ruling 28(h)/protocol F9: the two tables `collectLinkIds` previously never enumerated — a
  // `--link Y` on an unrelated link could silently delete Y's own scan-fact/confirm-observation
  // rows (they were excluded from `retained`) or, for a link living ONLY in one of these two
  // tables, could never be named by `--all` at all.
  for (const id of db.listScanFactLinkIds()) {
    ids.add(id)
  }
  for (const id of db.listConfirmObservationLinkIds()) {
    ids.add(id)
  }
  return [...ids]
}

function clampWaitMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? LINK_BINDING_STATUS_WAIT_CAP_MS, LINK_BINDING_STATUS_WAIT_CAP_MS)
}

// Ruling 28(f): the design's link-status row — routes, routingClass, peerKeyFingerprint,
// attestationExpiresAt, advisories[], environmentName (host-resolved), health word, counts.
function buildLinkRow(
  runtime: RpcContext['runtime'],
  linkDeviceId: string
): Record<string, unknown> {
  const db = runtime.getOrchestrationDb()
  const snapshot = readEnvironmentSnapshot()
  const binding = db.getPeerLinkBinding(linkDeviceId)
  const attempt = db.getBindingAttempt(linkDeviceId)
  const health = describeLinkBindingHealth(db, runtime, linkDeviceId, snapshot)
  const outboxPending = db.countPendingReplyOutbox(linkDeviceId)
  const routable = getRoutableLinkBinding(db, runtime, linkDeviceId, {}, snapshot)
  const legacyAttestation =
    binding?.grantClass === 'legacy_coalesced'
      ? db.getContainment('link', linkDeviceId, 'accept_legacy')
      : null
  const liveAttestation =
    legacyAttestation && legacyAttestation.liftedAt === null ? legacyAttestation : null
  const routingClass: 'minted' | 'legacy_attested' | 'legacy_unattested' | null =
    binding === null
      ? null
      : binding.grantClass === 'minted'
        ? 'minted'
        : liveAttestation !== null
          ? 'legacy_attested'
          : 'legacy_unattested'
  return {
    linkDeviceId,
    environmentId: binding?.environmentId ?? null,
    environmentName: binding
      ? resolveEnvironmentName(runtime, binding.environmentId, linkDeviceId)
      : null,
    state: binding?.state ?? null,
    grantClass: binding?.grantClass ?? null,
    routes: routable !== null,
    routingClass,
    peerKeyFingerprint: binding?.peerKeyFingerprint ?? null,
    attestationExpiresAt: liveAttestation?.expiresAt ?? null,
    advisories: attempt?.lastAdvisory ? [attempt.lastAdvisory] : [],
    health: health.word,
    healthLabel: renderLinkBindingHealth(health.word),
    unavailableReason: health.reason ?? null,
    lastRoundAt: attempt?.lastRoundAt ?? null,
    lastFullRoundAt: attempt?.lastFullRoundAt ?? null,
    outboxPending
  }
}

const LinkBindingsParams = z
  .object({
    link: z.string().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().optional()
  })
  .strict()

const LINK_BINDINGS_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkBindings',
  params: LinkBindingsParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const { runtime } = ctx
    // Ruling 28(c)/design test 61: server-side wait — only meaningful against a single named
    // link. Capped at LINK_BINDING_STATUS_WAIT_CAP_MS regardless of the caller's own
    // --timeout-ms (R22.1's ONE cap); a wait that expires is a report, never an error.
    let timedOut = false
    if (params.wait && params.link) {
      const settled = await runtime
        .getLinkBindingProver()
        .waitForSettle(params.link, clampWaitMs(params.timeoutMs))
      timedOut = settled === 'timeout'
    }
    const ids = params.link ? [params.link] : collectLinkIds(runtime)
    return {
      links: ids.map((linkDeviceId) => buildLinkRow(runtime, linkDeviceId)),
      ...(params.wait ? { state: timedOut ? 'timeout' : 'settled' } : {})
    }
  }
})

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
    if (params.link) {
      const known = collectLinkIds(runtime).includes(params.link)
      if (!known) {
        throw new OrchestrationError('invalid_argument', `No link known for ${params.link}.`)
      }
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
      // Ruling 28(a): the operator's single-link kick is 'operator_bind' (proveNow) — never
      // 'inbound_contact' (C7's declared deviation 3), so it is exempt from the peer-traffic kick
      // debounce and the park re-arm debounce, and bypasses the contested/revoked exclusions.
      const wasRevoked = db.getPeerLinkBinding(params.link)?.revokedAt != null
      if (wasRevoked) {
        // Ruling 28(a): clears a sticky revoke through its OWN guarded statement, audited, BEFORE
        // the round runs — `link-bind` is the only path licensed to lift a revoke.
        const now = Date.now()
        const cleared = db.unrevokePeerLinkBinding(params.link, now)
        if (cleared) {
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

const LinkFlagParams = z.object({ link: z.string() }).strict()

const LINK_REVOKE_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkRevoke',
  params: LinkFlagParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    // Ruling 28(d): a link device id names a row directly (there is no separate "link selector"
    // grammar) — an unresolvable one is still a hard refusal, never a silent no-op write.
    if (!collectLinkIds(ctx.runtime).includes(params.link)) {
      throw new OrchestrationError('invalid_argument', `No link known for ${params.link}.`)
    }
    const now = Date.now()
    const db = ctx.runtime.getOrchestrationDb()
    db.revokePeerLinkBinding(params.link, now)
    // Ruling 28(n): every write verb's row change is audited.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: params.link,
      verb: 'linkBinding',
      outcome: 'revoked',
      reasonCode: null
    })
    return { linkDeviceId: params.link, revokedAt: now }
  }
})

const LinkForgetParams = z
  .object({ link: z.string().optional(), all: z.boolean().optional() })
  .strict()

const LINK_FORGET_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkForget',
  params: LinkForgetParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    if (!params.link && !params.all) {
      throw new OrchestrationError('invalid_argument', 'Pass --link <deviceId> or --all.')
    }
    const { runtime } = ctx
    const all = collectLinkIds(runtime)
    // Ruling 28(d): a hard refusal, never a silent zero-row no-op, for an unknown link.
    if (params.link && !all.includes(params.link)) {
      throw new OrchestrationError('invalid_argument', `No link known for ${params.link}.`)
    }
    const forgotten = params.all ? all : all.filter((id) => id === params.link)
    // Ruling 28(h)/protocol F9: delete by INCLUSION over `forgotten` (never by exclusion from a
    // possibly-incomplete `retained` set) — honest, and race-safe against a binding row created
    // between the read above and this write.
    const db = runtime.getOrchestrationDb()
    db.deleteBindingsAndAttemptsIn(forgotten)
    // Ruling 28(n): every write verb's row change is audited.
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: 'local',
      verb: 'linkBinding',
      outcome: 'forgotten',
      reasonCode: JSON.stringify({ forgotten })
    })
    return { forgotten }
  }
})

export const ORCHESTRATION_LINK_BINDING_LOCAL_METHODS: RpcMethod[] = [
  LINK_BINDINGS_METHOD,
  LINK_BIND_METHOD,
  LINK_REVOKE_METHOD,
  LINK_FORGET_METHOD,
  ...ORCHESTRATION_LINK_BINDING_CONTAINMENT_METHODS,
  ...ORCHESTRATION_LINK_BINDING_OUTBOX_METHODS
]
