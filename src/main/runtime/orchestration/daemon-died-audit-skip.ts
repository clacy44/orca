// S10-21a C7f (D-R114 fix 3): index.ts's daemon_died fanout — skip the audit write when there
// is no launch row AND no registered (derived=0) row for the pane; nothing for the fact to be
// about (a plain shell that was never launched/registered on this pane).
export function shouldSkipDaemonDiedAudit(
  hasLaunchRow: boolean,
  registeredRow: { derived: number } | undefined
): boolean {
  if (hasLaunchRow) {
    return false
  }
  return registeredRow === undefined || registeredRow.derived !== 0
}
