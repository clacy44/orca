import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { RuntimeClient } from '../runtime-client'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  formatAudit,
  formatPersonList,
  formatStatus,
  personName,
  resolveDevice,
  resolvePerson,
  type LaneAuditRow,
  type LanePrincipal,
  type LaneStatusSnapshot
} from '../lane-format'

/**
 * Fail with "update the host" before touching a lane RPC on a runtime too old to have them.
 *
 * Why status.get and not the method's own `method_not_found`: the loud failure is a stack trace,
 * not one sentence naming the fix. The capability says exactly one thing — this host has per-person
 * Claude credential lanes — so its absence maps cleanly to a single instruction (S9 §3).
 */
async function assertLaneSupported(client: RuntimeClient): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca runtime does not have per-person Claude credential lanes. Update the host and try again.'
    )
  }
}

// Why reject rather than silently retarget: `orca lane` is a host-machine consent surface, so
// `--environment homelab` would aim it at the wrong box — the exact mistake the host-only door
// exists to prevent. Mirrors `orca account`'s guard.
function rejectRemoteSelectionFlags(ctx: HandlerContext): void {
  for (const flag of ['environment', 'pairing-code']) {
    if (ctx.flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `\`--${flag}\` does not retarget \`orca lane\`. Run it on the host whose lanes you want to manage.`
      )
    }
  }
}

function requireStringFlag(ctx: HandlerContext, flag: string): string {
  const value = ctx.flags.get(flag)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing a value for --${flag}.`)
  }
  return value
}

function optionalStringFlag(ctx: HandlerContext, flag: string): string | null {
  const value = ctx.flags.get(flag)
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function readStatus(client: RuntimeClient): Promise<LaneStatusSnapshot> {
  const response = await client.call<LaneStatusSnapshot>('accounts.lane.readStatus')
  return response.result
}

/** CLI handlers for `orca lane …` — the day-one per-person lane setup from a local shell. */
export const LANE_HANDLERS: Record<string, CommandHandler> = {
  'lane persons': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    await assertLaneSupported(ctx.client)
    const result = await ctx.client.call<{ principals: LanePrincipal[] }>(
      'accounts.lane.listPrincipals'
    )
    printResult(result, ctx.json, (value) => formatPersonList(value.principals))
  },
  'lane create-person': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const displayName = requireStringFlag(ctx, 'name')
    await assertLaneSupported(ctx.client)
    const result = await ctx.client.call<{ principalId: string; displayName: string }>(
      'accounts.lane.createPrincipal',
      { displayName }
    )
    printResult(result, ctx.json, (value) => `Created ${value.displayName}\n  ${value.principalId}`)
  },
  'lane bind': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const deviceSelector = requireStringFlag(ctx, 'device')
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const deviceId = resolveDevice(snapshot.grants, deviceSelector)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ bound: true }>('accounts.lane.bindGrant', {
      deviceId,
      principalId
    })
    printResult(
      result,
      ctx.json,
      () => `Bound ${deviceId} to ${personName(snapshot.principals, principalId)}`
    )
  },
  'lane unbind': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const deviceSelector = requireStringFlag(ctx, 'device')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const deviceId = resolveDevice(snapshot.grants, deviceSelector)
    const result = await ctx.client.call<{ unbound: boolean }>('accounts.lane.unbindGrant', {
      deviceId
    })
    printResult(result, ctx.json, (value) =>
      value.unbound ? `Unbound ${deviceId}` : `${deviceId} was not bound; nothing changed.`
    )
  },
  'lane rebind': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const deviceSelector = requireStringFlag(ctx, 'device')
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const deviceId = resolveDevice(snapshot.grants, deviceSelector)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ bound: true }>('accounts.lane.rebindGrant', {
      deviceId,
      principalId
    })
    printResult(
      result,
      ctx.json,
      () =>
        `Rebound ${deviceId} to ${personName(snapshot.principals, principalId)}. Re-designate their pusher before provisioning.`
    )
  },
  'lane designate': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    const deviceSelector = requireStringFlag(ctx, 'device')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const deviceId = resolveDevice(snapshot.grants, deviceSelector)
    const result = await ctx.client.call<{ designatedGrantId: string }>(
      'accounts.lane.designatePusher',
      { principalId, deviceId }
    )
    printResult(
      result,
      ctx.json,
      () => `Designated ${deviceId} as ${personName(snapshot.principals, principalId)}'s pusher`
    )
  },
  'lane provision': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    const acceptUnverifiedPlatform = ctx.flags.has('accept-unverified-platform')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ provisioned: true; provenanceLabel: string }>(
      'accounts.lane.provision',
      { principalId, ...(acceptUnverifiedPlatform ? { acceptUnverifiedPlatform: true } : {}) }
    )
    printResult(result, ctx.json, (value) => {
      const line = `Provisioned a lane for ${personName(snapshot.principals, principalId)} (${value.provenanceLabel})`
      return acceptUnverifiedPlatform
        ? `${line}\nAccepted an unverified platform for this lane; the acceptance is recorded in \`orca lane audit\`.`
        : line
    })
  },
  'lane deprovision': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ deprovisioned: boolean }>('accounts.lane.deprovision', {
      principalId
    })
    printResult(result, ctx.json, (value) =>
      value.deprovisioned
        ? `Deprovisioned ${personName(snapshot.principals, principalId)}'s lane`
        : `${personName(snapshot.principals, principalId)} had no lane; nothing changed.`
    )
  },
  'lane bind-link': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const homePeerFingerprint = requireStringFlag(ctx, 'link')
    // Why optional and checked, not passed: the RPC derives the principal from the grant the
    // fingerprint resolves to (there is one authority). `--person` is a caller's assertion of who
    // that is; if it disagrees, the bind is refused rather than silently running as someone else.
    const personSelector = optionalStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const result = await ctx.client.call<{ boundDeviceId: string }>(
      'accounts.lane.bindFederatedLink',
      { homePeerFingerprint }
    )
    const snapshot = await readStatus(ctx.client)
    const boundGrant = snapshot.grants.find(
      (grant) => grant.deviceId === result.result.boundDeviceId
    )
    const ownerId = boundGrant?.boundPrincipalId ?? null
    if (personSelector) {
      const expected = resolvePerson(snapshot.principals, personSelector)
      if (ownerId !== expected) {
        throw new RuntimeClientError(
          'invalid_argument',
          `The link binds to ${result.result.boundDeviceId}, which belongs to ${personName(snapshot.principals, ownerId)}, not ${personName(snapshot.principals, expected)}. Bind that device to the intended person first.`
        )
      }
    }
    printResult(
      result,
      ctx.json,
      (value) =>
        `Bound the federated link to ${value.boundDeviceId} (runs as ${personName(snapshot.principals, ownerId)})`
    )
  },
  'lane status': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    await assertLaneSupported(ctx.client)
    const response = await ctx.client.call<LaneStatusSnapshot>('accounts.lane.readStatus')
    const personSelector = optionalStringFlag(ctx, 'person')
    if (personSelector) {
      const principalId = resolvePerson(response.result.principals, personSelector)
      const filtered: LaneStatusSnapshot = {
        principals: response.result.principals.filter(
          (principal) => principal.principalId === principalId
        ),
        grants: response.result.grants.filter((grant) => grant.boundPrincipalId === principalId)
      }
      printResult({ ...response, result: filtered }, ctx.json, formatStatus)
      return
    }
    printResult(response, ctx.json, formatStatus)
  },
  'lane audit': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    await assertLaneSupported(ctx.client)
    const result = await ctx.client.call<{ audit: LaneAuditRow[] }>('accounts.lane.readAudit')
    printResult(result, ctx.json, (value) => formatAudit(value.audit))
  }
}
