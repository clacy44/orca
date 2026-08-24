import type { ReactElement } from 'react'
import { translate } from '@/i18n/i18n'
import type { ConsentAuditRowView } from './principal-consent-audit-rows'

function formatAuditTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function auditSentence(row: ConsentAuditRowView): string {
  const person = row.principalLabel ?? '—'
  const device = row.deviceLabel ?? '—'
  switch (row.action) {
    case 'create-principal':
      return translate(
        'auto.components.settings.PrincipalConsentAuditList.createPrincipal',
        'Added {{value0}}',
        { value0: person }
      )
    case 'bind':
      return translate(
        'auto.components.settings.PrincipalConsentAuditList.bind',
        'Bound {{value0}} to {{value1}}',
        { value0: device, value1: person }
      )
    case 'unbind':
      return translate(
        'auto.components.settings.PrincipalConsentAuditList.unbind',
        'Unbound {{value0}} from {{value1}}',
        { value0: device, value1: person }
      )
    case 'designate':
      return translate(
        'auto.components.settings.PrincipalConsentAuditList.designate',
        'Made {{value0}} the pusher for {{value1}}',
        { value0: device, value1: person }
      )
    case 'link-bind':
      return translate(
        'auto.components.settings.PrincipalConsentAuditList.linkBind',
        'Bound a federated link to {{value0}}',
        { value0: person }
      )
  }
}

/**
 * The consent audit trail (S9 §2a rule (iii)): the read-only log that makes a mis-tick visible and a
 * bind reversible. Each row is already resolved to display labels by `describeConsentAuditRow`, so
 * this only orders and paints them, newest first.
 */
export function PrincipalConsentAuditList({
  rows
}: {
  rows: readonly ConsentAuditRowView[]
}): ReactElement | null {
  if (rows.length === 0) {
    return null
  }
  const ordered = [...rows].sort((a, b) => b.at - a.at)
  return (
    <div className="space-y-1" data-testid="consent-audit-list">
      <h4 className="text-muted-foreground text-xs font-medium">
        {translate('auto.components.settings.PrincipalConsentAuditList.title', 'Consent history')}
      </h4>
      <ul className="space-y-0.5">
        {ordered.map((row, index) => (
          <li
            key={`${row.at}-${row.action}-${index}`}
            className="text-muted-foreground flex items-baseline justify-between gap-3 text-xs"
            data-testid="consent-audit-row"
          >
            <span className="min-w-0 truncate">{auditSentence(row)}</span>
            <span className="shrink-0 tabular-nums">{formatAuditTimestamp(row.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
