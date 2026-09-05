// S10-21a C7 (design v3.2 §2.1 "NO DOUBLE RESUME", D-R92 P2): the READ-ONLY IPC the renderer's
// own wake path consults before resuming a sleeping record — `agent_sweep_restore_marks` is a
// host-only, main-owned table (agent-sweep-restore-marks.ts); this channel returns a boolean
// only and has NO writable counterpart on any wire (`session:set`'s wholesale-replace semantics
// cannot reach it because it does not live in `WorkspaceSessionState` at all).
import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export function registerSweepRestoreMarkHandler(runtime: OrcaRuntimeService): void {
  ipcMain.handle('orchestration:sweepRestoreMark:get', (_event, paneKey: unknown): boolean => {
    if (typeof paneKey !== 'string' || paneKey.length === 0) {
      return false
    }
    const db = runtime.getOrchestrationDb()
    const hostId = runtime.getOrchestrationCompatibilityHostId()
    return db.getSweepRestoreMark(hostId, paneKey)
  })

  // [S10-21a C7c, D-R110 (ε)] The bulk read the renderer hydrates ONCE at startup — the shipped
  // per-key getter above would otherwise need one round-trip per sleeping record before any wake
  // path could safely run. Host-scoped, read-only, no writable counterpart, same as the getter.
  ipcMain.handle('orchestration:sweepRestoreMark:list', (): string[] => {
    const db = runtime.getOrchestrationDb()
    const hostId = runtime.getOrchestrationCompatibilityHostId()
    return db.listSweepRestoreMarks(hostId)
  })
}
