import type { EnvironmentTerminalRoster, RosterRow } from './runtime/environment-terminal-roster'

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
    row.title ?? '(untitled)'
  ]
  return row.agent ? `${columns.join('  ')}  [${row.agent}]` : columns.join('  ')
}

function formatReachability(row: RosterRow): string {
  if (row.reachability === 'ok') {
    return 'ok'
  }
  return row.reason ? `${row.reachability}(${row.reason})` : row.reachability
}
