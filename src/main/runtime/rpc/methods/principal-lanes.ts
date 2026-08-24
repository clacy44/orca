import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { ClaudeLaneRefusal } from '../../../../shared/claude-lane-refusals'
import { PRINCIPAL_DISPLAY_NAME_MAX_LENGTH } from '../../principal-registry-store'
import { authorizeHostConsent, type HostConsent } from '../../principal-consent-authority'
import {
  getPrincipalLaneConsentService,
  type PrincipalLaneConsentService
} from '../../principal-lane-consent-service'

const PrincipalIdParam = z.uuid('Invalid principalId')
const DeviceIdParam = z.string().min(1, 'Missing deviceId').max(256)

const CreatePrincipalParams = z
  .object({ displayName: z.string().min(1).max(PRINCIPAL_DISPLAY_NAME_MAX_LENGTH) })
  .strict()
const BindGrantParams = z
  .object({ deviceId: DeviceIdParam, principalId: PrincipalIdParam })
  .strict()
const UnbindGrantParams = z.object({ deviceId: DeviceIdParam }).strict()
const DesignateParams = z
  .object({ principalId: PrincipalIdParam, deviceId: DeviceIdParam })
  .strict()
const LinkParams = z.object({ homePeerFingerprint: z.string().length(64) }).strict()
const PrincipalParams = z.object({ principalId: PrincipalIdParam }).strict()
// B2: a dedicated params shape for provision alone (Rule 1 — a new optional field on an existing
// host-only method), so an older host that has never seen `acceptUnverifiedPlatform` still parses
// deprovision's identical-looking params unchanged.
const ProvisionParams = z
  .object({ principalId: PrincipalIdParam, acceptUnverifiedPlatform: z.boolean().optional() })
  .strict()

/**
 * Binding a device to a person, designating who pushes, and provisioning a lane are **host-side
 * consent actions**: the local human, at the machine (S9 §2a). These methods exist so the local
 * `orca` command can perform them over the runtime's own socket/named pipe, and every one of them
 * refuses an identified socket — the same shape `accounts.addClaudeFromConfigDir` already uses for
 * a host-only action, one layer above the `HostConsent` the service itself demands.
 */
export const PRINCIPAL_LANE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.lane.listPrincipals',
    params: null,
    handler: async (_params, ctx) =>
      withConsent(ctx.clientKind, (service) => ({
        principals: service.listPrincipals().map((principal) => ({
          principalId: principal.principalId,
          displayName: principal.displayName,
          delegatedGrantId: principal.delegatedGrantId ?? null
        }))
      }))
  }),
  defineMethod({
    // The host-only read the local `orca lane status` renders and every device-selector verb
    // resolves against. Behind `withConsent` like the writes: a roster of who is bound to whom is
    // a host-only fact, so an identified socket is refused here exactly as it is at a bind.
    name: 'accounts.lane.readStatus',
    params: null,
    handler: async (_params, ctx) =>
      withConsent(ctx.clientKind, (service) => ({
        grants: service.listGrants(),
        principals: service.listPrincipals().map((principal) => ({
          principalId: principal.principalId,
          displayName: principal.displayName,
          delegatedGrantId: principal.delegatedGrantId ?? null,
          laneState: service.laneResidencyState(principal.principalId),
          boundDeviceIds: service.boundDeviceIds(principal.principalId)
        }))
      }))
  }),
  defineMethod({
    // The undo trail (§2a rule (iii)); deletions stay visible. Host-only for the same reason.
    name: 'accounts.lane.readAudit',
    params: null,
    handler: async (_params, ctx) =>
      withConsent(ctx.clientKind, (service) => ({
        audit: service.listAudit().map((row) => ({ ...row }))
      }))
  }),
  defineMethod({
    name: 'accounts.lane.createPrincipal',
    params: CreatePrincipalParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        const principal = service.createPrincipal(consent, params.displayName)
        return { principalId: principal.principalId, displayName: principal.displayName }
      })
  }),
  defineMethod({
    name: 'accounts.lane.bindGrant',
    params: BindGrantParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        service.bindGrant(consent, params.deviceId, params.principalId)
        return { bound: true as const }
      })
  }),
  defineMethod({
    name: 'accounts.lane.unbindGrant',
    params: UnbindGrantParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => ({
        unbound: service.unbindGrant(consent, params.deviceId)
      }))
  }),
  defineMethod({
    // Why a distinct verb rather than a second bind: a bound row is never rewritten in place —
    // re-binding is unbind-then-bind, so the audit trail carries both directions.
    name: 'accounts.lane.rebindGrant',
    params: BindGrantParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        service.rebindGrant(consent, params.deviceId, params.principalId)
        return { bound: true as const }
      })
  }),
  defineMethod({
    name: 'accounts.lane.designatePusher',
    params: DesignateParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        service.designatePusher(consent, params.principalId, params.deviceId)
        return { designatedGrantId: params.deviceId }
      })
  }),
  defineMethod({
    name: 'accounts.lane.bindFederatedLink',
    params: LinkParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) =>
        service.bindFederatedLink(consent, params.homePeerFingerprint)
      )
  }),
  defineMethod({
    name: 'accounts.lane.provision',
    params: ProvisionParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        const lane = service.provisionLane(consent, params.principalId, {
          acceptUnverifiedPlatform: params.acceptUnverifiedPlatform === true
        })
        // Why the label and not the path: the response goes back over a socket, and the label is
        // the identifier every other surface is allowed to carry.
        return { provisioned: true as const, provenanceLabel: lane.provenanceLabel }
      })
  }),
  defineMethod({
    name: 'accounts.lane.deprovision',
    params: PrincipalParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, async (service, consent) => ({
        deprovisioned: await service.deprovisionLane(consent, params.principalId)
      }))
  })
]

function withConsent<T>(
  clientKind: 'mobile' | 'runtime' | undefined,
  run: (service: PrincipalLaneConsentService, consent: HostConsent) => T
): T {
  const consent = authorizeHostConsent({ clientKind })
  const service = getPrincipalLaneConsentService()
  if (!service) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.consent_caller_not_local',
      'Per-person Claude credential lanes are not enabled on this host yet, so there is nothing to bind or provision.'
    )
  }
  return run(service, consent)
}
