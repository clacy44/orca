// R266 DESIGN Q2 "Sentences" (INV-P-023): exact contract text. Lives in shared/ (not
// main/host-integrity) so the CLI project (config/tsconfig.cli.json includes ../src/shared/**)
// can import the same literals format-status-integrity.test.ts pins, instead of copying them —
// re-exported from host-integrity-guard.ts so no other module's imports change.
import type { ProcessIntegrityLevel } from './host-integrity-types'

function subjectFor(source: 'main' | 'daemon'): string {
  return source === 'main' ? "Orca's main process" : "Orca's terminal daemon"
}

function remedyFor(source: 'main' | 'daemon'): string {
  return source === 'main'
    ? 'Relaunch Orca normally from the Start menu (not from an elevated shell)'
    : 'Restart the terminal daemon from this non-elevated Orca (Manage Sessions → Restart)'
}

function describeLevel(level: ProcessIntegrityLevel): string {
  if (level === 'high') {
    return 'elevated (High integrity)'
  }
  if (level === 'low') {
    return 'at Low integrity'
  }
  return 'at an integrity level Orca could not verify'
}

export function hostIntegrityRefusalSentence(
  source: 'main' | 'daemon',
  level: ProcessIntegrityLevel
): string {
  return `${subjectFor(source)} is running ${describeLevel(level)}, so new agent sessions are refused. ${remedyFor(source)}, or set ORCA_ALLOW_ELEVATED=1 to allow them.`
}

export function hostIntegrityOverrideSentence(
  source: 'main' | 'daemon',
  level: ProcessIntegrityLevel
): string {
  return `${subjectFor(source)} is running ${describeLevel(level)} and ORCA_ALLOW_ELEVATED=1 is set, so agent sessions are allowed and inherit that integrity level.`
}

export const DAEMON_UNREPORTED_SENTENCE =
  "Orca's terminal daemon predates the elevation guard and cannot report its integrity level; restart it (Manage Sessions → Restart) to verify it is not elevated."
