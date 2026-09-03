// Ruling 28(d)/(e) (C8a): `orchestration.linkContainment` — split out of
// orchestration-link-binding-local.ts (max-lines) so the selector-resolution and per-write audit
// logic F-1/F-6/F3(protocol) require has its own budget. Every write/lift is audited (caller
// identity, subject, action, expiry); a re-attestation's PRIOR reason/expiry go to the audit row
// before `putContainment`'s upsert overwrites them (F-6).
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { requireLocalCaller } from './orchestration-link-binding-caller-gate'
import { resolveUserDataPath } from './orchestration-link-binding-pending'
import { resolveEnvironment } from '../../../../shared/runtime-environment-store'
import {
  deriveLinkQuarantineIncidentId,
  LINK_BINDING_LEGACY_ATTEST_TTL_MS
} from '../../orchestration/link-binding-constants'
import type {
  ContainmentAction,
  ContainmentSubjectKind
} from '../../orchestration/link-binding-observations-store'

// Ruling 28(d)/lifecycle F-1: resolve an operator-typed selector to the id the reading code
// actually keys on — an environment NAME or UUID resolves to the environment's UUID (the round's
// `db.getContainment('environment', environment.id, …)` reads the id, never the name); a link
// device id passes through unchanged (there is no separate "link selector" grammar — the CLI
// already requires `--link <deviceId>` verbatim). An unresolvable selector is a hard refusal.
export function resolveContainmentSubjectId(
  subjectKind: ContainmentSubjectKind,
  subjectId: string
): string {
  if (subjectKind !== 'environment') {
    return subjectId
  }
  try {
    return resolveEnvironment(resolveUserDataPath(), subjectId).id
  } catch {
    throw new OrchestrationError(
      'invalid_argument',
      `No saved environment matches selector ${subjectId}.`
    )
  }
}

const LinkContainmentParams = z
  .object({
    subjectKind: z.enum(['link', 'environment']),
    subjectId: z.string(),
    action: z.enum(['quarantine', 'scan_exclude', 'accept_legacy']),
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
    const subjectId = resolveContainmentSubjectId(subjectKind, params.subjectId)
    if (params.lift) {
      // F-6: the prior row's reason/expiry go to the audit row — the last record of what was
      // being withdrawn, since `liftContainment` only stamps `lifted_at`.
      const prior = db.getContainment(subjectKind, subjectId, action)
      db.liftContainment(subjectKind, subjectId, action, now)
      db.writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: 'local',
        verb: 'linkBinding',
        outcome: `${action}_lifted`,
        reasonCode: JSON.stringify({
          subjectKind,
          subjectId,
          priorReasonText: prior?.reasonText ?? null,
          priorExpiresAt: prior?.expiresAt ?? null
        })
      })
      return { subjectKind, subjectId, action, liftedAt: now }
    }
    // F-6: capture the prior attestation's own reason/expiry BEFORE the upsert overwrites them —
    // `putContainment`'s `ON CONFLICT … DO UPDATE` silently rewrites `reason_text`/`expires_at`
    // in place; the audit row is the only durable record the earlier one existed.
    const prior = db.getContainment(subjectKind, subjectId, action)
    db.putContainment({
      subjectKind,
      subjectId,
      action,
      reasonCode: action === 'quarantine' ? 'operator_quarantine' : `operator_${action}`,
      reasonText: params.reason ?? null,
      detail:
        action === 'quarantine'
          ? JSON.stringify({ incidentId: deriveLinkQuarantineIncidentId(subjectId, now) })
          : null,
      createdAt: now,
      expiresAt:
        params.expiresAt ??
        (action === 'accept_legacy' ? now + LINK_BINDING_LEGACY_ATTEST_TTL_MS : null)
    })
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: 'local',
      verb: 'linkBinding',
      outcome: prior && prior.liftedAt === null ? `${action}_reasserted` : action,
      reasonCode: JSON.stringify({
        subjectKind,
        subjectId,
        reasonText: params.reason ?? null,
        priorReasonText: prior?.reasonText ?? null,
        priorExpiresAt: prior?.expiresAt ?? null
      })
    })
    return db.getContainment(subjectKind, subjectId, action)
  }
})

export const ORCHESTRATION_LINK_BINDING_CONTAINMENT_METHODS: RpcMethod[] = [LINK_CONTAINMENT_METHOD]
