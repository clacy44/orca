import { killWithDescendantSweep } from '../pty-descendant-termination'
import {
  terminateWindowsProcessTreeReportingExit,
  type WindowsTreeKiller
} from '../windows-process-tree-kill'
import {
  verifyWindowsTreeKillTarget,
  type WindowsTreeKillTarget
} from '../windows-pty-root-identity'
import type { Session } from './session'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

function checkpointTerminalHostSessions(
  sessions: ReadonlyMap<string, Session>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void
): void {
  if (!onFinalCheckpoint) {
    return
  }
  for (const [sessionId, session] of sessions) {
    if (!session.isAlive) {
      continue
    }
    const take = session.takePendingOutput(true, { teardownSnapshot: true })
    if (!take?.snapshot) {
      continue
    }
    try {
      onFinalCheckpoint(sessionId, take.snapshot, take.records)
    } catch {
      // Final checkpoints are best-effort and must not block native teardown.
    }
  }
}

export type TerminalHostShutdownDeps = {
  platform?: NodeJS.Platform
  sweep?: typeof killWithDescendantSweep
  /** taskkill /T /F; its exit code decides whether the root was taken by the tree kill. */
  killWindowsTree?: WindowsTreeKiller
  verifyTreeKillTarget?: (rootPid: number) => Promise<WindowsTreeKillTarget>
}

async function disposeTerminalHostSessions(
  sessions: Iterable<Session>,
  deps: TerminalHostShutdownDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  const sweep = deps.sweep ?? killWithDescendantSweep
  const verify = deps.verifyTreeKillTarget ?? verifyWindowsTreeKillTarget
  const killTree = deps.killWindowsTree ?? terminateWindowsProcessTreeReportingExit
  const results = await Promise.allSettled(
    [...sessions].map(async (session) => {
      session.detachAllClients()
      // Why: live children retain native ownership until physical exit, while
      // exited children must release handles without signalling a recycled pid.
      if (session.isAlive) {
        let treeKilled = false
        if (platform === 'win32') {
          // Why: ConPTY closure does not reap the console's other processes and `taskkill /T` cannot start from a dead root, so the tree goes first.
          treeKilled = await sweepSessionTreeBeforeRootKill(session, sweep, verify, killTree)
        }
        if (treeKilled) {
          // Why not force-kill: taskkill already took the root, and node-pty frees its pid on exit, so a second PID-based kill could hit a stranger.
          console.warn('[daemon] Session dispose after tree kill: branch=await_exit')
          await session.waitForExitAndDisposeSubprocess()
        } else {
          if (platform === 'win32') {
            console.warn(
              '[daemon] Session dispose without a confirmed tree kill: branch=force_kill'
            )
          }
          await session.forceKillAndDisposeSubprocess()
        }
      } else {
        if (platform === 'win32') {
          console.warn('[daemon] Skipping session tree kill on dispose: reason=root_not_alive')
        }
        session.disposeSubprocess()
      }
    })
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (rejected) {
    throw rejected.reason
  }
}

async function sweepSessionTreeBeforeRootKill(
  session: Session,
  sweep: typeof killWithDescendantSweep,
  verify: (rootPid: number) => Promise<WindowsTreeKillTarget>,
  killTree: WindowsTreeKiller
): Promise<boolean> {
  // Why capture here: the sweep returns nothing, and taskkill only runs for an identity-verified, still-owned root, so its
  // exit code is exactly "did the tree kill take this root". Anything but a reported 0 leaves the root's fate unproven.
  let taskkillExitCode: number | null = null
  try {
    await sweep(session.pid, () => {}, {
      platform: 'win32',
      // Why: the descendant tree is only ours while this Session still owns the live root PID.
      ownsRoot: () => session.isAlive,
      verifyTreeKillTarget: async (rootPid) => {
        const target = await verify(rootPid)
        if (target !== 'own') {
          console.warn(`[daemon] Skipping session tree kill on dispose: reason=root_${target}`)
        }
        return target
      },
      killWindowsTree: async (rootPid) => {
        const result = await killTree(rootPid)
        taskkillExitCode = result?.exitCode ?? null
        return result
      }
    })
    return taskkillExitCode === 0
  } catch (error) {
    // Why: a failed sweep must never keep the root alive; the force-kill still runs.
    console.warn(
      `[daemon] Session tree kill on dispose failed: reason=sweep_failed error=${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

export async function shutdownTerminalHostSessions(
  sessions: Map<string, Session>,
  onFinalCheckpoint?: (
    sessionId: string,
    snapshot: TerminalSnapshot,
    records: TakePendingOutputResult['records']
  ) => void,
  deps?: TerminalHostShutdownDeps
): Promise<void> {
  checkpointTerminalHostSessions(sessions, onFinalCheckpoint)
  await disposeTerminalHostSessions(sessions.values(), deps)
  sessions.clear()
}
