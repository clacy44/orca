import { useEffect, useState, type ReactElement } from 'react'
import { translate } from '@/i18n/i18n'
import {
  getPresenceRosterEnvironmentIds,
  getPresenceRosterForEnvironment,
  onPresenceRosterChange
} from '@/lib/pane-manager/terminal-presence-state'
import {
  buildRuntimePresenceRosterRows,
  type RuntimePresenceRosterRow
} from './runtime-presence-roster-rows'

function rosterEntries(): [string, ReturnType<typeof getPresenceRosterForEnvironment>][] {
  return getPresenceRosterEnvironmentIds().map((environmentId) => [
    environmentId,
    getPresenceRosterForEnvironment(environmentId)
  ])
}

// Why composed here and not host-side: the host publishes a bare machine name, because "(host)" is a
// display convention this locale owns and hostname() can legitimately be empty.
function rowLabel(row: RuntimePresenceRosterRow): string {
  if (row.kind === 'host') {
    return translate(
      'auto.components.status.bar.RuntimePresenceStatusRows.77ee51bf9b',
      '{{value0}} (host)',
      { value0: row.label }
    )
  }
  if (row.self) {
    return translate(
      'auto.components.status.bar.RuntimePresenceStatusRows.3241616dae',
      '{{value0}} (you)',
      { value0: row.label }
    )
  }
  return row.label
}

function rowDetail(row: RuntimePresenceRosterRow): string {
  if (row.activeTabTitle) {
    return row.activeTabTitle
  }
  return row.attachedCount > 0
    ? translate('auto.components.status.bar.RuntimePresenceStatusRows.ce809af553', 'Attached')
    : translate('auto.components.status.bar.RuntimePresenceStatusRows.97fd835cd3', 'Idle')
}

export function RuntimePresenceStatusRows(): ReactElement | null {
  // Why a counter: the roster lives outside the store so a keystroke-rate lane cannot fan out through it.
  const [, setRosterTick] = useState(0)
  useEffect(() => onPresenceRosterChange(() => setRosterTick((n) => n + 1)), [])
  const { rows, truncated } = buildRuntimePresenceRosterRows(rosterEntries())
  if (rows.length === 0) {
    // A solo desktop with no pairings renders no section at all.
    return null
  }
  return (
    <>
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {translate('auto.components.status.bar.RuntimePresenceStatusRows.faa72294ac', 'People')}
      </div>
      {rows.map((row) => (
        <div
          key={`${row.environmentId}:${row.participantId}`}
          className="flex items-center gap-2.5 px-2 py-1.5"
          data-presence-kind={row.kind}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">{rowLabel(row)}</div>
            <div className="truncate text-[10px] text-muted-foreground">{rowDetail(row)}</div>
          </div>
        </div>
      ))}
      {truncated ? (
        <div className="px-2 pb-1.5 text-[10px] text-muted-foreground">
          {translate(
            'auto.components.status.bar.RuntimePresenceStatusRows.4f4b1f6a3c',
            'More people not shown'
          )}
        </div>
      ) : null}
    </>
  )
}
