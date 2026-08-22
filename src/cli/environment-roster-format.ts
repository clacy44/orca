import type { RuntimeTerminalPresence } from '../shared/runtime-types'
import type { EnvironmentTerminalRoster, RosterRow } from './runtime/environment-terminal-roster'

// Why a format and not a copy: the wire ships an object while a roster row carries one column of text,
// so the peer's capability answer ('presence' in terminal) must be read before this runs, never from
// whether the string it returns is empty.
export function formatTerminalPresence(presence: RuntimeTerminalPresence | undefined): string {
  return (presence?.participants ?? [])
    .map((participant) => {
      // Why typing wins: it is the interactive stamp, the one a peer's next keystroke can collide with.
      if (participant.typing) {
        return `${participant.label} (typing)`
      }
      return participant.writing ? `${participant.label} (writing)` : participant.label
    })
    .join(', ')
}

export function formatEnvironmentTerminalRoster(roster: EnvironmentTerminalRoster): string {
  if (roster.rows.length === 0) {
    return 'No runtimes to poll. Save a peer with: orca environment add --name <name> --pairing-code <code>'
  }
  const summary = `${roster.reachableCount}/${roster.runtimeCount} runtimes reachable, ${roster.terminalCount} terminals${roster.truncated ? ' (truncated)' : ''}`
  return [...roster.rows.map(formatRosterRow), '', summary].join('\n')
}

function formatRosterRow(row: RosterRow): string {
  const columns = [
    row.environment,
    row.runtimeId ?? 'unknown-runtime',
    formatReachability(row),
    row.terminal ?? '(no terminals)',
    row.title ?? '(untitled)',
    formatPresenceColumn(row)
  ]
  return row.agent ? `${columns.join('  ')}  [${row.agent}]` : columns.join('  ')
}

// Why three states and not two: a peer that never published the key is UNKNOWN, not empty — printing
// "-" there would claim nobody is on a terminal this runtime cannot see the presence of at all.
function formatPresenceColumn(row: RosterRow): string {
  if (row.presence === undefined) {
    return 'presence?'
  }
  return row.presence && row.presence.length > 0 ? row.presence : '-'
}

function formatReachability(row: RosterRow): string {
  if (row.reachability === 'ok') {
    return 'ok'
  }
  return row.reason ? `${row.reachability}(${row.reason})` : row.reachability
}
