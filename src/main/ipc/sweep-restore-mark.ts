// S10-21a C7 (design v3.2 §2.1 "NO DOUBLE RESUME", D-R92 P2): the READ-ONLY IPC the renderer's
// own wake path consults before resuming a sleeping record — `agent_sweep_restore_marks` is a
// host-only, main-owned table (agent-sweep-restore-marks.ts); this channel returns a boolean
// only and has NO writable counterpart on any wire (`session:set`'s wholesale-replace semantics
// cannot reach it because it does not live in `WorkspaceSessionState` at all).
import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { awaitRestoreSweepLockRelease } from '../runtime/restore-sweep-lock'
import type { SweepRestoreMarkListReply } from '../../shared/sweep-restore-mark-list'

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
  //
  // [S10-21a C15, R52, D-V7 F1] The renderer's hydration must see the POST-SWEEP view, not
  // whatever happens to be in the table at the moment it asks — the sweep can still be running
  // (C7b: it starts after the window opens, gated on daemon/hook readiness only). So this AWAITS
  // the sweep's own lock release (bounded by the same 30s bound the lock is held for at most)
  // before reading. On 'timeout' it answers anyway with the current (possibly pre-sweep) marks
  // plus `sweepIncomplete: true` — additive, read-only, no new channel — so a caller can tell the
  // difference between "no marks" and "didn't wait long enough to know".
  ipcMain.handle(
    'orchestration:sweepRestoreMark:list',
    async (): Promise<SweepRestoreMarkListReply> => {
      const waitResult = await awaitRestoreSweepLockRelease()
      const db = runtime.getOrchestrationDb()
      const hostId = runtime.getOrchestrationCompatibilityHostId()
      const paneKeys = db.listSweepRestoreMarks(hostId)
      return waitResult === 'timeout' ? { paneKeys, sweepIncomplete: true } : { paneKeys }
    }
  )
}
