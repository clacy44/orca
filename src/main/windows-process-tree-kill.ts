import { execFile } from 'node:child_process'

/** What a killer may report: `exitCode` is taskkill's real exit code, null when taskkill never ran to an exit (spawn error, timeout). */
export type WindowsTreeKillResult = { exitCode: number | null }
export type WindowsTreeKiller = (rootPid: number) => Promise<void | WindowsTreeKillResult>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/**
 * Force-kill a Windows process and every descendant (`taskkill /T /F`).
 * Best-effort: missing/already-dead roots still resolve so callers can finish
 * their own handle cleanup via killRoot.
 */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile } = {}
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve()
  }
  const run = deps.execFileImpl ?? execFile
  return new Promise((resolve) => {
    run(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      {
        // Why: a wedged taskkill must not block killRoot forever (#10004 review).
        timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true
      },
      () => {
        resolve()
      }
    )
  })
}

/**
 * Same kill as `terminateWindowsProcessTree`, but reports taskkill's real exit code so a caller can tell
 * "the tree was killed" from "taskkill ran and failed". Never rejects.
 */
export function terminateWindowsProcessTreeReportingExit(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile } = {}
): Promise<WindowsTreeKillResult> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve({ exitCode: null })
  }
  const run = deps.execFileImpl ?? execFile
  return new Promise((resolve) => {
    run(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      { timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (!error) {
          resolve({ exitCode: 0 })
          return
        }
        const code = (error as { code?: unknown }).code
        if (typeof code === 'number') {
          resolve({ exitCode: code })
          return
        }
        // Why log: a spawn error or timeout is not "taskkill failed on this tree"; the caller treats it as not killed.
        console.warn(
          `[process-tree-kill] taskkill did not run to an exit for pid ${rootPid}: ${error.message}`
        )
        resolve({ exitCode: null })
      }
    )
  })
}
