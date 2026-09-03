// S10-16 C7/C8a, R22 (design v6): the local-operator link-binding surface — `linkBindings`,
// `linkRevoke`, `linkForget`. `linkBind`, `linkContainment` and `replyOutbox` live in their own
// files (orchestration-link-binding-bind/-containment/-outbox.ts, C8a max-lines split). Every
// verb opens with the shared local-caller gate (R22, Ruling 28(h): the positive form, R23.4/
// R30.3: never registered on the peer allowlist — test 53).
import { z } from 'zod'
import { defineMethod, type RpcMethod, type RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  describeLinkBindingHealth,
  resolveEnvironmentName,
  linkRoutingClassOf
} from '../../orchestration/link-binding-attention'
import {
  readEnvironmentSnapshot,
  getRoutableLinkBinding
} from '../../orchestration/link-binding-routable'
import { renderLinkBindingHealth } from '../../../../shared/link-binding-health'
import { requireLocalCaller } from './orchestration-link-binding-caller-gate'
import { collectLinkIds } from './orchestration-link-binding-ids'
import { resolveUserDataPath } from './orchestration-link-binding-pending'
import { resolveEnvironment } from '../../../../shared/runtime-environment-store'
import { ORCHESTRATION_LINK_BINDING_BIND_METHODS } from './orchestration-link-binding-bind'
import { ORCHESTRATION_LINK_BINDING_CONTAINMENT_METHODS } from './orchestration-link-binding-containment'
import { ORCHESTRATION_LINK_BINDING_OUTBOX_METHODS } from './orchestration-link-binding-outbox'
import { LINK_BINDING_STATUS_WAIT_CAP_MS } from '../../orchestration/link-binding-constants'

function clampWaitMs(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? LINK_BINDING_STATUS_WAIT_CAP_MS, LINK_BINDING_STATUS_WAIT_CAP_MS)
}

// Ruling 28(f): the design's link-status row — routes, routingClass, peerKeyFingerprint,
// attestationExpiresAt, advisories[], environmentName (host-resolved), health word, counts.
// Ruling 28 Addendum 1(s)/D-9: `snapshot` is hoisted by the caller (one read per call, not one
// per link) and `routingClass` is `linkRoutingClassOf` — the same predicate `routingClassOf`
// checks expiry and the environment/key match; this file no longer keeps a weaker, liftedAt-only
// copy.
function buildLinkRow(
  runtime: RpcContext['runtime'],
  linkDeviceId: string,
  snapshot: ReturnType<typeof readEnvironmentSnapshot>
): Record<string, unknown> {
  const db = runtime.getOrchestrationDb()
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
  const routingClass = linkRoutingClassOf(db, binding, Date.now())
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
    // Lifecycle F-12/Ruling 28: the CLI spec advertises `--environment <selector>` on
    // `link-status` but no code path ever read it — a documented flag that does nothing is a
    // defect. Implemented server-side (matching the (d) selector-resolution precedent every
    // other write verb already uses), never left as a silent no-op.
    environment: z.string().optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().optional()
  })
  .strict()

// Ruling 28: reused (d)'s selector-resolution shape — a name or UUID resolves to the
// environment's UUID (the shape `buildLinkRow`'s own `environmentId` is keyed on); an
// unresolvable selector is a hard refusal, never a filter that silently matches nothing.
function resolveEnvironmentFilterId(selector: string): string {
  try {
    return resolveEnvironment(resolveUserDataPath(), selector).id
  } catch {
    throw new OrchestrationError(
      'invalid_argument',
      `No saved environment matches selector ${selector}.`
    )
  }
}

const LINK_BINDINGS_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkBindings',
  params: LinkBindingsParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const { runtime } = ctx
    // Ruling 28 Addendum 1(p)/D-6: `--wait` is only meaningful against a single named link — a
    // wait with no `--link` waited on nothing and must never report `state: 'settled'` as though
    // it had. Hard refusal, not a silent no-op.
    if (params.wait && !params.link) {
      throw new OrchestrationError('invalid_argument', '--wait requires --link <deviceId>.')
    }
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
    // Ruling 27(b)/D-9: hoisted out of the .map — one environment-store read per call, not one
    // per link.
    const snapshot = readEnvironmentSnapshot()
    let links = ids.map((linkDeviceId) => buildLinkRow(runtime, linkDeviceId, snapshot))
    if (params.environment !== undefined) {
      const resolvedEnvironmentId = resolveEnvironmentFilterId(params.environment)
      links = links.filter((l) => l.environmentId === resolvedEnvironmentId)
    }
    return {
      links,
      ...(params.wait ? { state: timedOut ? 'timeout' : 'settled' } : {})
    }
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
  LINK_REVOKE_METHOD,
  LINK_FORGET_METHOD,
  ...ORCHESTRATION_LINK_BINDING_BIND_METHODS,
  ...ORCHESTRATION_LINK_BINDING_CONTAINMENT_METHODS,
  ...ORCHESTRATION_LINK_BINDING_OUTBOX_METHODS
]
