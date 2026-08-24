import { RuntimeClientError } from './runtime-client'
import type { RuntimeTerminalLaneState } from '../shared/runtime-types'

// Why the CLI defines these wire shapes rather than importing the runtime's: `orca lane` reaches
// the host-only RPCs (principal-lanes.ts) over the local socket, and only reads the fields below —
// keeping them here avoids pulling main-process types (and the renderer typecheck) into the CLI.
export type LanePrincipal = {
  principalId: string
  displayName: string
  delegatedGrantId: string | null
}

export type LaneGrant = {
  deviceId: string
  label: string
  perPerson: boolean
  boundPrincipalId: string | null
  designated: boolean
  redeemed: boolean
}

export type LaneStatusPrincipal = LanePrincipal & {
  laneState: RuntimeTerminalLaneState
  boundDeviceIds: string[]
}

export type LaneStatusSnapshot = {
  grants: LaneGrant[]
  principals: LaneStatusPrincipal[]
}

export type LaneAuditRow = {
  at: number
  action: string
  principalId: string | null
  deviceId?: string
  direction?: 'bind' | 'unbind'
  homePeerFingerprint?: string
  designatedGrantId?: string | null
  platformAcceptance?: 'unverified-win32' | 'unverified-darwin'
}

/**
 * Resolve a `--device` selector to one deviceId: an exact id, an exact pairing label, or a unique
 * id prefix. An ambiguous prefix is refused with its candidates listed, never resolved to a guess.
 */
export function resolveDevice(grants: LaneGrant[], selector: string): string {
  const exactId = grants.find((grant) => grant.deviceId === selector)
  if (exactId) {
    return exactId.deviceId
  }
  const labelMatches = grants.filter(
    (grant) => grant.label.toLowerCase() === selector.toLowerCase()
  )
  const chosen =
    labelMatches.length > 0
      ? labelMatches
      : grants.filter((grant) => grant.deviceId.startsWith(selector))
  if (chosen.length === 1) {
    return chosen[0].deviceId
  }
  if (chosen.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No paired device matches "${selector}". Run \`orca lane status\` to list devices by id and label.`
    )
  }
  const candidates = chosen.map((grant) => `  ${grant.deviceId}  ${grant.label}`).join('\n')
  throw new RuntimeClientError(
    'invalid_argument',
    `"${selector}" matches more than one device:\n${candidates}\nRe-run with a longer id prefix or the exact device id.`
  )
}

/** Resolve a `--person` selector to one principalId: an exact id or an exact display name. */
export function resolvePerson(principals: LanePrincipal[], selector: string): string {
  const exactId = principals.find((principal) => principal.principalId === selector)
  if (exactId) {
    return exactId.principalId
  }
  const nameMatches = principals.filter(
    (principal) => principal.displayName.toLowerCase() === selector.toLowerCase()
  )
  if (nameMatches.length === 1) {
    return nameMatches[0].principalId
  }
  if (nameMatches.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No person matches "${selector}". Run \`orca lane persons\` to list people by id and name.`
    )
  }
  const candidates = nameMatches
    .map((principal) => `  ${principal.principalId}  ${principal.displayName}`)
    .join('\n')
  throw new RuntimeClientError(
    'invalid_argument',
    `"${selector}" matches more than one person:\n${candidates}\nRe-run with the exact person id.`
  )
}

export function personName(principals: LanePrincipal[], principalId: string | null): string {
  if (!principalId) {
    return '(none)'
  }
  return (
    principals.find((principal) => principal.principalId === principalId)?.displayName ??
    principalId
  )
}

function personDevice(grants: LaneGrant[], deviceId: string): string {
  const grant = grants.find((row) => row.deviceId === deviceId)
  return grant ? `${grant.label} (${grant.deviceId})` : deviceId
}

export function formatPersonList(principals: LanePrincipal[]): string {
  if (principals.length === 0) {
    return 'No people. Create one with: orca lane create-person --name <name>'
  }
  const lines = principals.map(
    (principal) =>
      `  ${principal.displayName}  ${principal.principalId}${principal.delegatedGrantId ? '  (pusher designated)' : ''}`
  )
  return `People (${principals.length}):\n${lines.join('\n')}`
}

export function formatStatus(snapshot: LaneStatusSnapshot): string {
  const principals = snapshot.principals
  const laneLines =
    principals.length === 0
      ? ['No people yet. Create one with: orca lane create-person --name <name>']
      : principals.map((principal) => {
          const designated = principal.delegatedGrantId
            ? personDevice(snapshot.grants, principal.delegatedGrantId)
            : '(no pusher designated)'
          return `  ${principal.displayName}  lane:${principal.laneState}  devices:${principal.boundDeviceIds.length}  pusher:${designated}`
        })
  const unbound = snapshot.grants.filter((grant) => grant.boundPrincipalId === null)
  const deviceLines = snapshot.grants.map((grant) => {
    const owner = grant.boundPrincipalId
      ? personName(principals, grant.boundPrincipalId)
      : 'unbound'
    const marks = [
      grant.perPerson ? 'per-person' : 'shared',
      ...(grant.designated ? ['pusher'] : []),
      ...(grant.redeemed ? [] : ['invite outstanding'])
    ]
    return `  ${grant.deviceId}  ${grant.label}  ->  ${owner}  [${marks.join(', ')}]`
  })
  return [
    `People (${principals.length}):`,
    ...laneLines,
    '',
    `Devices (${snapshot.grants.length}, ${unbound.length} unbound):`,
    ...(deviceLines.length > 0 ? deviceLines : ['  (none paired)']),
    '',
    'lane: loaded = a credential is resident; absent = none; reauth-required = a foreign rotation'
  ].join('\n')
}

export function formatAudit(rows: LaneAuditRow[]): string {
  if (rows.length === 0) {
    return 'No lane audit entries.'
  }
  const lines = rows.map((row) => {
    const parts = [new Date(row.at).toISOString(), row.action]
    if (row.direction) {
      parts.push(row.direction)
    }
    if (row.deviceId) {
      parts.push(`device=${row.deviceId}`)
    }
    if (row.principalId) {
      parts.push(`person=${row.principalId}`)
    }
    if (row.designatedGrantId !== undefined) {
      parts.push(`pusher=${row.designatedGrantId ?? 'cleared'}`)
    }
    if (row.homePeerFingerprint) {
      parts.push(`link=${row.homePeerFingerprint}`)
    }
    if (row.platformAcceptance) {
      parts.push(`platform=${row.platformAcceptance}`)
    }
    return `  ${parts.join('  ')}`
  })
  return `Lane audit (${rows.length}):\n${lines.join('\n')}`
}
