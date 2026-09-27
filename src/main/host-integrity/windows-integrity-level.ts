// INV-P-023: detect the current process's Windows mandatory integrity label via `whoami /groups`.
// No PowerShell, no native module (E2/E4). SIDs only, never localized labels (Q1.2/Q1.3).
import { execFile } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'
import type { ProcessIntegrityLevel } from '../../shared/host-integrity-types'

export type IntegrityProbe = { level: ProcessIntegrityLevel | 'n/a'; detail: string }

export const WHOAMI_GROUPS_ARGS = ['/groups', '/fo', 'csv', '/nh']
export const WHOAMI_TIMEOUT_MS = 5_000
export const INCONCLUSIVE_RETRY_MS = 30_000
const WHOAMI_SETTLE_GUARD_MS = 6_000

const MANDATORY_LABEL_FIELD = /"((?:[^"]|"")*)"/g
const MANDATORY_LABEL_SID = /^S-1-16-(\d{1,10})$/

function classifyRid(rid: number): ProcessIntegrityLevel {
  if (rid >= 0x3000) {
    return 'high'
  }
  if (rid >= 0x2000) {
    return 'medium'
  }
  return 'low'
}

/** Exactly Q1.2: SIDs only, never labels; NULs stripped so mis-decoded UTF-16LE still parses. */
export function parseWhoamiGroupsCsv(stdout: string): IntegrityProbe {
  const cleaned = stdout.replaceAll('\u0000', '')
  const matches: string[] = []
  for (const m of cleaned.matchAll(MANDATORY_LABEL_FIELD)) {
    const field = m[1].replaceAll('""', '"')
    if (MANDATORY_LABEL_SID.test(field)) {
      matches.push(field)
    }
  }
  if (matches.length === 0) {
    return { level: 'unknown', detail: 'no mandatory label in whoami output' }
  }
  if (matches.length > 1) {
    return { level: 'unknown', detail: `ambiguous mandatory labels (${matches.length})` }
  }
  const rid = Number(MANDATORY_LABEL_SID.exec(matches[0])![1])
  return { level: classifyRid(rid), detail: matches[0] }
}

function getWhoamiPath(systemRoot: string): string {
  return pathWin32.join(systemRoot, 'System32', 'whoami.exe')
}

export function runWhoami(file: string, execFileImpl: typeof execFile = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileImpl(
      file,
      [...WHOAMI_GROUPS_ARGS],
      { encoding: 'utf8', windowsHide: true, timeout: WHOAMI_TIMEOUT_MS, maxBuffer: 1_048_576 },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout)
        }
      }
    )
  })
}

/** Never rejects: every failure mode resolves to 'unknown' (Q1.5). */
export function probeCurrentProcessIntegrity(
  deps: {
    platform?: NodeJS.Platform
    systemRoot?: string
    runWhoamiImpl?: (file: string) => Promise<string>
  } = {}
): Promise<IntegrityProbe> {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    return Promise.resolve({ level: 'n/a', detail: `platform ${platform}` })
  }
  const systemRoot =
    deps.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  const whoamiPath = getWhoamiPath(systemRoot)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ level: 'unknown', detail: 'whoami did not settle' })
      }
    }, WHOAMI_SETTLE_GUARD_MS)
    timer.unref?.()
    Promise.resolve()
      .then(() => (deps.runWhoamiImpl ?? ((f) => runWhoami(f)))(whoamiPath))
      .then(parseWhoamiGroupsCsv, (e) => ({
        level: 'unknown' as const,
        detail: `whoami failed: ${e?.code ?? e?.message}`
      }))
      .then((probe) => {
        if (!settled) {
          settled = true
          resolve(probe)
        }
      })
      .finally(() => clearTimeout(timer))
  })
}

/** A conclusive level is final for the process; 'unknown' is re-probed after INCONCLUSIVE_RETRY_MS. */
export class ProcessIntegrityCache {
  private settled: { probe: IntegrityProbe; at: number } | null = null
  private inFlight: Promise<IntegrityProbe> | null = null

  constructor(
    private readonly probe: () => Promise<IntegrityProbe>,
    private readonly now: () => number = Date.now,
    private readonly onSettle: (probe: IntegrityProbe) => void = () => {}
  ) {}

  peek(): IntegrityProbe | null {
    return this.settled?.probe ?? null
  }

  resolve(): Promise<IntegrityProbe> {
    if (this.settled) {
      const conclusive = this.settled.probe.level !== 'unknown'
      const fresh = this.now() - this.settled.at < INCONCLUSIVE_RETRY_MS
      if (conclusive || fresh) {
        return Promise.resolve(this.settled.probe)
      }
    }
    if (this.inFlight) {
      return this.inFlight
    }
    this.inFlight = this.probe()
      .catch((): IntegrityProbe => ({ level: 'unknown', detail: 'probe rejected' }))
      .then((probe) => {
        this.settled = { probe, at: this.now() }
        this.inFlight = null
        this.onSettle(probe)
        return probe
      })
    return this.inFlight
  }
}

/** The terminal daemon reports at boot without delaying readiness (Q1 "Daemon"). */
export function startDaemonIntegrityReport(
  log: { log(event: string, details?: unknown): void },
  probe: () => Promise<IntegrityProbe> = () => probeCurrentProcessIntegrity()
): { current(): ProcessIntegrityLevel | undefined } {
  const cache = new ProcessIntegrityCache(probe, Date.now, (settled) => {
    if (settled.level !== 'n/a') {
      log.log('integrity', { level: settled.level, detail: settled.detail })
    }
  })
  void cache.resolve()
  return {
    current(): ProcessIntegrityLevel | undefined {
      const settled = cache.peek()
      if (!settled || settled.level === 'n/a') {
        return undefined
      }
      if (settled.level === 'unknown') {
        void cache.resolve()
      }
      return settled.level
    }
  }
}
