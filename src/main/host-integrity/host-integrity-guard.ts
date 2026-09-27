// INV-P-023: the single admission chokepoint for the Windows elevation guard. Detection lives in
// windows-integrity-level.ts; this module classifies, refuses, and audits.
import {
  ALLOW_ELEVATED_ENV,
  HOST_INTEGRITY_AUDIT_VERB,
  type DaemonIntegrityReport,
  type ProcessIntegrityLevel,
  type RuntimeHostIntegrity
} from '../../shared/host-integrity-types'
import { HostElevatedRefusedError } from '../ipc/agent-launch-admission-errors'
import {
  ProcessIntegrityCache,
  probeCurrentProcessIntegrity,
  type IntegrityProbe
} from './windows-integrity-level'

type HostIntegrityAuditRow = {
  agentId: null
  actorPaneKey: string | null
  actorHostId: string | null
  verb: string
  outcome: string
  reasonCode: string
}

let probe: () => Promise<IntegrityProbe> = () => probeCurrentProcessIntegrity()
let clock: () => number = Date.now
let cache: ProcessIntegrityCache | null = null
let elevationRead = false
let elevationAllowed = false
let readDaemon: () => DaemonIntegrityReport | null = () => null
let lastLoggedLevel: ProcessIntegrityLevel | undefined
let startupObservationRecorded = false

function logMainProbe(settled: IntegrityProbe): void {
  if (settled.level === 'n/a' || settled.level === lastLoggedLevel) {
    return
  }
  lastLoggedLevel = settled.level
  if (settled.level === 'medium') {
    console.log(`[host-integrity] main process integrity: medium (${settled.detail})`)
  } else {
    const verdict = elevationAllowed ? 'allowed by ORCA_ALLOW_ELEVATED=1' : 'refused'
    console.warn(
      `[host-integrity] main process integrity: ${settled.level} (${settled.detail}); new agent sessions are ${verdict} (INV-P-023)`
    )
  }
}

/** Idempotent: reads the override env once and starts (or reuses) the single probe cache. */
export function startHostIntegrityDetection(
  env: NodeJS.ProcessEnv = process.env
): Promise<IntegrityProbe> {
  if (!elevationRead) {
    elevationRead = true
    elevationAllowed = env[ALLOW_ELEVATED_ENV] === '1'
  }
  if (!cache) {
    cache = new ProcessIntegrityCache(probe, clock, logMainProbe)
  }
  return cache.resolve()
}

export function setDaemonIntegrityReader(reader: () => DaemonIntegrityReport | null): void {
  readDaemon = reader
}

export function classifyDaemonIntegrity(
  identity: { launchNonce: string; integrityLevel?: ProcessIntegrityLevel } | null,
  selfSpawnedLaunchNonces: ReadonlySet<string>
): DaemonIntegrityReport {
  if (identity && selfSpawnedLaunchNonces.has(identity.launchNonce)) {
    return 'inherited'
  }
  return identity?.integrityLevel ?? 'unreported'
}

export function hostIntegrityBlocker(
  main: ProcessIntegrityLevel,
  daemon: DaemonIntegrityReport | null,
  includeDaemon: boolean
): { source: 'main' | 'daemon'; level: ProcessIntegrityLevel } | null {
  if (main !== 'medium') {
    return { source: 'main', level: main }
  }
  if (includeDaemon && (daemon === 'high' || daemon === 'unknown' || daemon === 'low')) {
    return { source: 'daemon', level: daemon }
  }
  return null
}

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

function reasonCodeFor(
  main: ProcessIntegrityLevel,
  daemon: DaemonIntegrityReport | null,
  agent: string,
  via: string
): string {
  return `main=${main} daemon=${daemon ?? 'none'} agent=${agent} via=${via}`
}

/** The single chokepoint every fresh agent spawn (and create/ensure fail-fast) calls. */
export async function assertHostIntegrityAllowsAgentLaunch(args: {
  includeDaemon: boolean
  agent: string
  paneKey: string | null
  hostId: string | null
  via: 'admission' | 'create_agent_session' | 'ensure_agent_session'
  recordOverride: boolean
  getDb: () => { writeAgentAudit(row: HostIntegrityAuditRow): void } | undefined
}): Promise<void> {
  const settled = await startHostIntegrityDetection()
  const main = settled.level
  if (main === 'n/a') {
    return
  }
  const daemon = readDaemon()
  const blocker = hostIntegrityBlocker(main, daemon, args.includeDaemon)
  if (!blocker) {
    return
  }
  if (elevationAllowed && !args.recordOverride) {
    return
  }
  try {
    args.getDb()?.writeAgentAudit({
      agentId: null,
      actorPaneKey: args.paneKey,
      actorHostId: args.hostId,
      verb: HOST_INTEGRITY_AUDIT_VERB,
      outcome: elevationAllowed ? 'allowed_by_override' : 'refused',
      reasonCode: reasonCodeFor(main, daemon, args.agent, args.via)
    })
  } catch (e) {
    console.error(e)
  }
  if (!elevationAllowed) {
    throw new HostElevatedRefusedError(
      hostIntegrityRefusalSentence(blocker.source, blocker.level),
      {
        source: blocker.source,
        main,
        daemon
      }
    )
  }
}

/** Fed to `orca status`; waits only for the first probe, never for a background retry. */
export async function readRuntimeHostIntegrity(): Promise<RuntimeHostIntegrity | undefined> {
  const settled = cache?.peek() ?? (await startHostIntegrityDetection())
  const main = settled.level
  if (main === 'n/a') {
    return undefined
  }
  if (main === 'unknown') {
    void startHostIntegrityDetection()
  }
  const daemon = readDaemon()
  const blocker = hostIntegrityBlocker(main, daemon, true)
  const refused = blocker !== null && !elevationAllowed
  let warning: string | undefined
  if (blocker) {
    warning = elevationAllowed
      ? hostIntegrityOverrideSentence(blocker.source, blocker.level)
      : hostIntegrityRefusalSentence(blocker.source, blocker.level)
  } else if (daemon === 'unreported') {
    warning = DAEMON_UNREPORTED_SENTENCE
  }
  return {
    level: blocker?.level ?? main,
    main,
    ...(daemon !== null ? { daemon: daemon === 'inherited' ? main : daemon } : {}),
    elevationAllowed,
    agentLaunch: refused ? 'refused' : 'allowed',
    ...(warning ? { warning } : {})
  }
}

/** Runs once per process; a console warning plus one audit row whenever the state is abnormal. */
export async function recordHostIntegrityStartupObservation(args: {
  hostId: string | null
  writeAudit: (row: HostIntegrityAuditRow) => void
}): Promise<void> {
  if (startupObservationRecorded) {
    return
  }
  startupObservationRecorded = true
  try {
    const view = await readRuntimeHostIntegrity()
    if (!view?.warning) {
      return
    }
    console.warn(`[host-integrity] ${view.warning}`)
    args.writeAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: args.hostId,
      verb: HOST_INTEGRITY_AUDIT_VERB,
      outcome: 'observed',
      reasonCode: `main=${view.main} daemon=${view.daemon ?? 'none'} override=${elevationAllowed ? '1' : '0'}`
    })
  } catch (e) {
    console.error(e)
  }
}

export function configureHostIntegrityForTests(opts: {
  probe: () => Promise<IntegrityProbe>
  env?: NodeJS.ProcessEnv
  now?: () => number
  daemon?: () => DaemonIntegrityReport | null
}): void {
  probe = opts.probe
  clock = opts.now ?? Date.now
  cache = null
  elevationRead = false
  elevationAllowed = false
  readDaemon = opts.daemon ?? (() => null)
  lastLoggedLevel = undefined
  startupObservationRecorded = false
  if (opts.env) {
    void startHostIntegrityDetection(opts.env)
  }
}

export function resetHostIntegrityForTests(): void {
  probe = () => probeCurrentProcessIntegrity()
  clock = Date.now
  cache = null
  elevationRead = false
  elevationAllowed = false
  readDaemon = () => null
  lastLoggedLevel = undefined
  startupObservationRecorded = false
}
