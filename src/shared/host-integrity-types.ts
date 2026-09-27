// INV-P-023 vocabulary shared by main, the terminal daemon's hello and `orca status`.
export const PROCESS_INTEGRITY_LEVELS = ['low', 'medium', 'high', 'unknown'] as const
export type ProcessIntegrityLevel = (typeof PROCESS_INTEGRITY_LEVELS)[number]
/** 'inherited': a daemon this Orca process forked; 'unreported': a daemon that predates the field. */
export type DaemonIntegrityReport = ProcessIntegrityLevel | 'unreported' | 'inherited'
export type RuntimeHostIntegrity = {
  /** The level a new local agent session would get: the worse of main and the terminal daemon. */
  level: ProcessIntegrityLevel
  main: ProcessIntegrityLevel
  /** Absent when no terminal daemon serves this host. */
  daemon?: ProcessIntegrityLevel | 'unreported'
  elevationAllowed: boolean
  agentLaunch: 'allowed' | 'refused'
  warning?: string
}
export const ALLOW_ELEVATED_ENV = 'ORCA_ALLOW_ELEVATED'
export const HOST_ELEVATED_REFUSED_CODE = 'host_elevated_refused'
export const HOST_INTEGRITY_AUDIT_VERB = 'host_integrity'
export function isProcessIntegrityLevel(value: unknown): value is ProcessIntegrityLevel {
  return (
    typeof value === 'string' && (PROCESS_INTEGRITY_LEVELS as readonly string[]).includes(value)
  )
}
