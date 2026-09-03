// S10-16 C7, R22: the six link-binding CLI verbs against the local RPCs in
// `orchestration-link-binding-local.ts`. One formatter per verb; JSON output is the raw RPC result.
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalStringFlag,
  getOptionalPositiveIntegerFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime/types'
import {
  LINK_BINDING_STATUS_MS_PER_SECOND,
  LINK_BINDING_STATUS_SECONDS_PER_MINUTE,
  LINK_BINDING_STATUS_SECONDS_PER_HOUR
} from '../../main/runtime/orchestration/link-binding-constants'

type LinkRow = {
  linkDeviceId: string
  environmentId: string | null
  state: string | null
  grantClass: string | null
  health: string
  healthLabel: string
  unavailableReason: string | null
  lastRoundAt: number | null
  lastFullRoundAt: number | null
  outboxPending: number
}

const JUST_NOW_THRESHOLD_S = 5

function formatWhen(ms: number | null): string {
  if (ms === null) {
    return '—'
  }
  const deltaS = Math.max(0, Math.round((Date.now() - ms) / LINK_BINDING_STATUS_MS_PER_SECOND))
  if (deltaS < JUST_NOW_THRESHOLD_S) {
    return 'just now'
  }
  if (deltaS < LINK_BINDING_STATUS_SECONDS_PER_MINUTE) {
    return `${deltaS}s ago`
  }
  if (deltaS < LINK_BINDING_STATUS_SECONDS_PER_HOUR) {
    return `${Math.round(deltaS / LINK_BINDING_STATUS_SECONDS_PER_MINUTE)}m ago`
  }
  return `${Math.round(deltaS / LINK_BINDING_STATUS_SECONDS_PER_HOUR)}h ago`
}

function formatLinkStatus(result: { links: LinkRow[] }): string {
  if (result.links.length === 0) {
    return 'No links known.'
  }
  const lines = result.links.map((l) => {
    const health = l.unavailableReason ? `${l.healthLabel}(${l.unavailableReason})` : l.healthLabel
    return `${l.linkDeviceId}  ${health}  grant=${l.grantClass ?? '—'}  environment=${l.environmentId ?? '—'}  last round ${formatWhen(l.lastRoundAt)}  outbox ${l.outboxPending}`
  })
  return lines.join('\n')
}

export const ENVIRONMENT_LINK_BINDING_HANDLERS: Record<string, CommandHandler> = {
  'environment link-status': async ({ flags, client, json }) => {
    const link = getOptionalStringFlag(flags, 'link')
    const drain = flags.has('drain')
    if (drain) {
      const result = await client.call<{ drained: Record<string, number> }>(
        'orchestration.replyOutbox',
        { link, drain: true }
      )
      printResult(result, json, (r) =>
        Object.entries(r.drained)
          .map(([id, pending]) => `${id}: ${pending} pending`)
          .join('\n')
      )
      return
    }
    if (flags.has('outbox')) {
      const result = await client.call<{ items: unknown[] }>('orchestration.replyOutbox', { link })
      printResult(result, json, (r) => `${r.items.length} queued`)
      return
    }
    // --wait: the server-side wait is bounded by LINK_BINDING_STATUS_WAIT_CAP_MS regardless of the
    // client's own --timeout-ms (R22.1's one cap); the CLI's own socket timeout is raised to give
    // that wait room to answer rather than time out the transport underneath it.
    const timeoutMs = flags.has('wait')
      ? (getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? undefined)
      : undefined
    const result = await client.call<{ links: LinkRow[] }>(
      'orchestration.linkBindings',
      { link },
      timeoutMs !== undefined ? { timeoutMs } : undefined
    )
    printResult(result, json, formatLinkStatus)
  },

  'environment link-bind': async ({ flags, client, json }) => {
    const link = getOptionalStringFlag(flags, 'link')
    const all = flags.has('all')
    if ((link ? 1 : 0) + (all ? 1 : 0) !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --link or --all.')
    }
    const acceptLegacy = flags.has('accept-legacy')
    if (acceptLegacy && !flags.has('yes')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--accept-legacy is an operator attestation; pass --yes to confirm.'
      )
    }
    const result = await client.call<{
      state: string
      link?: string
      attemptId?: string
      kicked?: string[]
    }>('orchestration.linkBind', {
      link,
      all,
      deep: flags.has('deep'),
      acceptLegacy,
      reason: getOptionalStringFlag(flags, 'reason')
    })
    printResult(result, json, (r) =>
      r.link
        ? `${r.state}: ${r.link} (${r.attemptId})`
        : `${r.state}: kicked ${r.kicked?.length ?? 0} links`
    )
  },

  'environment link-revoke': async ({ flags, client, json }) => {
    const link = getRequiredStringFlag(flags, 'link')
    const result = await client.call<{ linkDeviceId: string; revokedAt: number }>(
      'orchestration.linkRevoke',
      { link }
    )
    printResult(result, json, (r) => `Revoked ${r.linkDeviceId}.`)
  },

  'environment link-forget': async ({ flags, client, json }) => {
    const link = getOptionalStringFlag(flags, 'link')
    const all = flags.has('all')
    if ((link ? 1 : 0) + (all ? 1 : 0) !== 1) {
      throw new RuntimeClientError('invalid_argument', 'Pass exactly one of --link or --all.')
    }
    if (!flags.has('yes')) {
      throw new RuntimeClientError('invalid_argument', 'Pass --yes to confirm link-forget.')
    }
    const result = await client.call<{ forgotten: string[] }>('orchestration.linkForget', {
      link,
      all
    })
    printResult(result, json, (r) => `Forgot ${r.forgotten.length} link(s).`)
  },

  'environment link-quarantine': async ({ flags, client, json }) => {
    const link = getRequiredStringFlag(flags, 'link')
    const lift = flags.has('lift')
    const result = await client.call('orchestration.linkContainment', {
      subjectKind: 'link',
      subjectId: link,
      action: 'quarantine',
      lift,
      reason: getOptionalStringFlag(flags, 'reason')
    })
    printResult(result, json, () =>
      lift ? `Lifted quarantine on ${link}.` : `Quarantined ${link}.`
    )
  },

  'environment link-exclude': async ({ flags, client, json }) => {
    const environment = getRequiredStringFlag(flags, 'environment')
    const clear = flags.has('clear')
    const result = await client.call('orchestration.linkContainment', {
      subjectKind: 'environment',
      subjectId: environment,
      action: 'scan_exclude',
      lift: clear,
      reason: getOptionalStringFlag(flags, 'reason')
    })
    printResult(result, json, () =>
      clear ? `Cleared scan exclusion on ${environment}.` : `Excluded ${environment} from scans.`
    )
  }
}
