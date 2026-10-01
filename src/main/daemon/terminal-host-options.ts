import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SubprocessHandle } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

export type TerminalHostOptions = {
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    startupCommandDelivery?: StartupCommandDelivery
    launchAgent?: TuiAgent
    shellOverride?: string
    terminalWindowsWslDistro?: string | null
    terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  }) => SubprocessHandle
  // Why: login-session death detection (#7936) needs subprocess exits even when no client is attached.
  onSessionReaped?: (sessionId: string) => void
  // Why: graceful shutdown checkpoints must finish in-process before teardown.
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
  // Why: a refused resize must be visible in daemon.log; the daemon owns the log.
  onResizeRejected?: (sessionId: string, size: { cols: number; rows: number }) => void
  // Why: tests need deterministic tombstone eviction without thousands of sessions.
  maxTombstones?: number
}
