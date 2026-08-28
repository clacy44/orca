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
  /** §6's S9-L3 migration: a `.credentials.json` from before the per-lane login model — never
   * wiped on sight, never promoted, replaced by the lane's first successful `orca lane login`. */
  unverifiedLegacy: boolean
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
  inviteScope?: 'runtime' | 'mobile'
  inviteExpiresAt?: number
}

export type LaneAccount = {
  laneAccountId: string
  email: string
  label: string | null
  active: boolean
}

export type LaneInvite = {
  deviceId: string
  deviceIdPrefix: string
  principalId: string
  displayName: string
  scope: 'runtime' | 'mobile'
  expiresAt: number
  pairingUrl: string
  webClientUrl: string | null
  endpoint: string
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

/** Resolve `--account <id|email>` against a lane's captured logins: an exact laneAccountId, or an
 * exact (case-insensitive) email — never a prefix, since an email is not a stable-prefixed id. */
export function resolveLaneAccount(accounts: LaneAccount[], selector: string): LaneAccount {
  const exactId = accounts.find((account) => account.laneAccountId === selector)
  if (exactId) {
    return exactId
  }
  const emailMatches = accounts.filter(
    (account) => account.email.toLowerCase() === selector.toLowerCase()
  )
  if (emailMatches.length === 1) {
    return emailMatches[0]
  }
  if (emailMatches.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No signed-in account matches "${selector}". Run \`orca lane accounts --person <name>\` to list this lane's accounts by id and email.`
    )
  }
  const candidates = emailMatches
    .map((account) => `  ${account.laneAccountId}  ${account.email}`)
    .join('\n')
  throw new RuntimeClientError(
    'invalid_argument',
    `"${selector}" matches more than one signed-in account:\n${candidates}\nRe-run with the exact account id.`
  )
}

export function formatAccountList(accounts: LaneAccount[]): string {
  if (accounts.length === 0) {
    return 'No signed-in accounts. Sign one in with: orca lane login --person <name> --email <email>'
  }
  const lines = accounts.map(
    (account) =>
      `  ${account.active ? '*' : ' '} ${account.email}${account.label ? ` (${account.label})` : ''}  ${account.laneAccountId}`
  )
  return `Accounts (${accounts.length}, * = active):\n${lines.join('\n')}`
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
          const legacy = principal.unverifiedLegacy
            ? `  [unverified legacy — run \`orca lane login --person "${principal.displayName}" --email <email>\` to replace it]`
            : ''
          return `  ${principal.displayName}  lane:${principal.laneState}  devices:${principal.boundDeviceIds.length}  pusher:${designated}${legacy}`
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

function formatInviteExpiry(expiresAt: number): string {
  const date = new Date(expiresAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatInvite(invite: LaneInvite): string {
  const lines = [
    `Invite for ${invite.displayName} — ${invite.scope} scope, expires ${formatInviteExpiry(invite.expiresAt)}`,
    `  device  ${invite.deviceIdPrefix}`,
    `  link    ${invite.pairingUrl}`,
    ...(invite.webClientUrl ? [`  web     ${invite.webClientUrl}     (runtime scope only)`] : []),
    ...(invite.scope === 'mobile'
      ? [
          'A mobile invite can be bound and designated but can never push a credential; designate a runtime grant as the pusher.'
        ]
      : []),
    `Redeem on that machine:  orca environment add --name <label> --pairing-code '${invite.pairingUrl}'`,
    '                         or Orca → Settings → Environments → Add',
    `Then, back here:         orca lane bind --device ${invite.deviceIdPrefix} --person "${invite.displayName}"`
  ]
  return lines.join('\n')
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
    if (row.action === 'mint-invite') {
      if (row.inviteScope) {
        parts.push(`scope=${row.inviteScope}`)
      }
      if (row.inviteExpiresAt !== undefined) {
        parts.push(`expires=${formatInviteExpiry(row.inviteExpiresAt)}`)
      }
    }
    return `  ${parts.join('  ')}`
  })
  return `Lane audit (${rows.length}):\n${lines.join('\n')}`
}
