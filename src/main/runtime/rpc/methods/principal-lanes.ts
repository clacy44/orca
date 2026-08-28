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
// `force` is required-true, not a plain boolean flag: a param an older/careless caller could omit
// and still trigger the release is the exact footgun `--force` exists to make deliberate.
const ForceWipeLatchParams = z
  .object({ principalId: PrincipalIdParam, force: z.literal(true) })
  .strict()
// B2: a dedicated params shape for provision alone (Rule 1 — a new optional field on an existing
// host-only method), so an older host that has never seen `acceptUnverifiedPlatform` still parses
// deprovision's identical-looking params unchanged.
const ProvisionParams = z
  .object({ principalId: PrincipalIdParam, acceptUnverifiedPlatform: z.boolean().optional() })
  .strict()
// Why exactly one of principalId/displayName is not enforced in the schema: the CLI always sends
// principalId (resolved from `--person` before the call), while displayName exists so a future
// host UI can invite by name directly. Both being absent or both present is refused at the handler.
const MintInviteParams = z
  .object({
    principalId: PrincipalIdParam.optional(),
    displayName: z.string().min(1).max(PRINCIPAL_DISPLAY_NAME_MAX_LENGTH).optional(),
    scope: z.enum(['runtime', 'mobile']).default('runtime'),
    ttlHours: z.number().int().min(1).max(24).optional(),
    address: z.string().min(1).max(255).optional()
  })
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
    // Host-only, same as every other write here (`withConsent` refuses any identified socket at
    // `authorizeHostConsent`) — NEVER added to MOBILE_RPC_METHOD_ALLOWLIST, because it mints a live
    // bearer credential rather than pointing at one. The CLI resolves `--person` to a principalId
    // before calling; `displayName` exists only for a future host UI that invites by name directly.
    name: 'accounts.lane.mintInvite',
    params: MintInviteParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => {
        const principalId =
          params.principalId ??
          service.listPrincipals().find((row) => row.displayName === params.displayName)
            ?.principalId
        if (!principalId) {
          throw new ClaudeLaneRefusal(
            'accounts.lane.person_unknown',
            'Orca has no record of that person. Create them first with `orca lane create-person --name <name>`, then invite them.'
          )
        }
        return service.mintInvite(consent, {
          principalId,
          scope: params.scope,
          ...(params.ttlHours !== undefined ? { ttlHours: params.ttlHours } : {}),
          ...(params.address !== undefined ? { address: params.address } : {})
        })
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
  }),
  defineMethod({
    // S9-L1 §fenceWiring "THE LATCH RELEASE": `orca lane wipe --person <name> --force`. Host-only,
    // like every other write here — an operator override of a latch is exactly the kind of action
    // that must originate at the machine, never over a paired connection.
    name: 'accounts.lane.wipe',
    params: ForceWipeLatchParams,
    handler: async (params, ctx) =>
      withConsent(ctx.clientKind, (service, consent) => ({
        released: service.forceWipeLatch(consent, params.principalId)
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
