// S10-16 C7, R22 (design v6, frozen): the local-operator link-binding surface — `linkBindings`,
// `linkBind`, `linkRevoke`, `linkForget`, `linkContainment`, `replyOutbox`. Every verb opens with
// the verbatim local-caller gate (R22, R23.4/R30.3: these are local reads/containment verbs, never
// registered on the peer allowlist — test 53). Kicks are non-blocking (R8.6/R22.1): `linkBind`
// schedules through the prover's own `scheduleBinding`/`requestRerun` and returns immediately.
import { z } from 'zod'
import { defineMethod, type RpcMethod, type RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { describeLinkBindingHealth } from '../../orchestration/link-binding-attention'
import { readEnvironmentSnapshot } from '../../orchestration/link-binding-routable'
import { renderLinkBindingHealth } from '../../../../shared/link-binding-health'
import {
  deriveLinkQuarantineIncidentId,
  LINK_BINDING_LEGACY_ATTEST_TTL_MS
} from '../../orchestration/link-binding-constants'
import type {
  ContainmentAction,
  ContainmentSubjectKind
} from '../../orchestration/link-binding-observations-store'

function requireLocalCaller(ctx: RpcContext): void {
  if (ctx.pairedDeviceId != null || ctx.clientKind === 'mobile') {
    throw new OrchestrationError('forbidden', 'Link binding state is local-operator only.')
  }
}

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
  return [...ids]
}

const LinkBindingsParams = z.object({ link: z.string().optional() }).strict()

const LINK_BINDINGS_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkBindings',
  params: LinkBindingsParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const { runtime } = ctx
    const db = runtime.getOrchestrationDb()
    const snapshot = readEnvironmentSnapshot()
    const ids = params.link ? [params.link] : collectLinkIds(runtime)
    return {
      links: ids.map((linkDeviceId) => {
        const binding = db.getPeerLinkBinding(linkDeviceId)
        const attempt = db.getBindingAttempt(linkDeviceId)
        const health = describeLinkBindingHealth(db, runtime, linkDeviceId, snapshot)
        const outboxPending = db.countPendingReplyOutbox(linkDeviceId)
        return {
          linkDeviceId,
          environmentId: binding?.environmentId ?? null,
          state: binding?.state ?? null,
          grantClass: binding?.grantClass ?? null,
          health: health.word,
          healthLabel: renderLinkBindingHealth(health.word),
          unavailableReason: health.reason ?? null,
          lastRoundAt: attempt?.lastRoundAt ?? null,
          lastFullRoundAt: attempt?.lastFullRoundAt ?? null,
          outboxPending
        }
      })
    }
  }
})

const LinkBindParams = z
  .object({
    link: z.string().optional(),
    all: z.boolean().optional(),
    deep: z.boolean().optional(),
    acceptLegacy: z.boolean().optional(),
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
    if (params.acceptLegacy) {
      if (!params.link || !params.reason) {
        throw new OrchestrationError(
          'invalid_argument',
          '--accept-legacy requires exactly one --link and a --reason.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const binding = db.getPeerLinkBinding(params.link)
      if (!binding) {
        throw new OrchestrationError(
          'invalid_argument',
          `No binding known for link ${params.link}.`
        )
      }
      const now = Date.now()
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
    }
    const ids = params.link ? [params.link] : collectLinkIds(runtime)
    const prover = runtime.getLinkBindingProver()
    for (const linkDeviceId of ids) {
      prover.scheduleBinding(linkDeviceId, 'inbound_contact')
    }
    if (params.deep) {
      prover.requestRerun('contest_search')
    }
    return params.link
      ? { state: 'running', link: params.link, attemptId: `${params.link}:${Date.now()}` }
      : { state: 'running', kicked: ids }
  }
})

const LinkFlagParams = z.object({ link: z.string() }).strict()

const LINK_REVOKE_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkRevoke',
  params: LinkFlagParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const now = Date.now()
    ctx.runtime.getOrchestrationDb().revokePeerLinkBinding(params.link, now)
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
    const forgotten = params.all ? all : all.filter((id) => id === params.link)
    const retained = params.all ? [] : all.filter((id) => id !== params.link)
    runtime.getOrchestrationDb().deleteBindingsAndAttemptsNotIn(retained)
    return { forgotten }
  }
})

const LinkContainmentParams = z
  .object({
    subjectKind: z.enum(['link', 'environment']),
    subjectId: z.string(),
    action: z.enum(['quarantine', 'scan_exclude']),
    lift: z.boolean().optional(),
    reason: z.string().optional(),
    expiresAt: z.number().nullable().optional()
  })
  .strict()

const LINK_CONTAINMENT_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.linkContainment',
  params: LinkContainmentParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const db = ctx.runtime.getOrchestrationDb()
    const now = Date.now()
    const subjectKind = params.subjectKind as ContainmentSubjectKind
    const action = params.action as ContainmentAction
    if (params.lift) {
      db.liftContainment(subjectKind, params.subjectId, action, now)
      return { subjectKind, subjectId: params.subjectId, action, liftedAt: now }
    }
    db.putContainment({
      subjectKind,
      subjectId: params.subjectId,
      action,
      reasonCode: action === 'quarantine' ? 'operator_quarantine' : 'operator_scan_exclude',
      reasonText: params.reason ?? null,
      detail:
        action === 'quarantine'
          ? JSON.stringify({ incidentId: deriveLinkQuarantineIncidentId(params.subjectId, now) })
          : null,
      createdAt: now,
      expiresAt: params.expiresAt ?? null
    })
    return db.getContainment(subjectKind, params.subjectId, action)
  }
})

const ReplyOutboxParams = z
  .object({ link: z.string().optional(), drain: z.boolean().optional() })
  .strict()

const REPLY_OUTBOX_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.replyOutbox',
  params: ReplyOutboxParams,
  handler: async (params, ctx) => {
    requireLocalCaller(ctx)
    const db = ctx.runtime.getOrchestrationDb()
    if (params.drain) {
      const ids = params.link ? [params.link] : collectLinkIds(ctx.runtime)
      const now = Date.now()
      const pending: Record<string, number> = {}
      for (const linkDeviceId of ids) {
        db.kickReplyOutboxForLink(linkDeviceId, now)
        pending[linkDeviceId] = db.countPendingReplyOutbox(linkDeviceId)
      }
      return { drained: pending }
    }
    return { items: db.listReplyOutbox(params.link) }
  }
})

export const ORCHESTRATION_LINK_BINDING_LOCAL_METHODS: RpcMethod[] = [
  LINK_BINDINGS_METHOD,
  LINK_BIND_METHOD,
  LINK_REVOKE_METHOD,
  LINK_FORGET_METHOD,
  LINK_CONTAINMENT_METHOD,
  REPLY_OUTBOX_METHOD
]
