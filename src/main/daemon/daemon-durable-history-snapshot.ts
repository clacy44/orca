import { ColdRestoreReplayWriter } from './cold-restore-replay-writer'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { HeadlessEmulator } from './headless-emulator'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences'
import { COLD_RESTORE_SEED_MODE_RESET } from '../../shared/terminal-mode-reset-profiles'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { PendingOutputRecord, TerminalModes, TerminalSnapshot } from './types'

type RestoreBase = {
  scrollbackAnsi: string
  rehydrateSequences: string
  snapshotAnsi: string
  pendingEscapeTailAnsi?: string
  oscLinks?: TerminalSnapshot['oscLinks']
  lastTitle?: string
  cwd: string | null
  cols: number
  rows: number
}

// Why: a cold-restore checkpoint's mouse bits describe whatever the SIGKILLed
// owner last armed, not a live process — trusting them forward makes the
// checkpoint a fixed point (#12101). Alt-screen/paste/cursor bits stay: they
// describe recoverable screen content, not a process that can re-arm input.
// `liveModes`, when given, is the CURRENT owning process's modes (this path
// is only ever reached with one — see buildDurableCheckpointSnapshot below):
// a genuinely live owner still armed for mouse input must win over whatever
// the on-disk checkpoint happened to have last recorded, or reattach/periodic
// checkpoints strip mouse tracking from sessions that never died (#8291).
function clearStaleColdRestoreMouseModes(
  modes: TerminalModes,
  liveModes?: TerminalModes
): TerminalModes {
  if (liveModes?.mouseTracking) {
    // Why the live owner's fields win wholesale, not field-by-field: a live
    // process that still has mouse tracking armed is the ground truth for
    // the whole mouse mode group, not just the on/off bit.
    return {
      ...modes,
      mouseTracking: true,
      mouseTrackingMode: liveModes.mouseTrackingMode,
      sgrMouseMode: liveModes.sgrMouseMode,
      sgrMousePixelsMode: liveModes.sgrMousePixelsMode
    }
  }
  return {
    ...modes,
    mouseTracking: false,
    mouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false
  }
}

export function terminalSnapshotFromColdRestore(
  info: ColdRestoreInfo,
  opts?: { outputSequence?: number; frameRestoreAnsi?: string; liveModes?: TerminalModes }
): TerminalSnapshot {
  const modes = clearStaleColdRestoreMouseModes(info.modes, opts?.liveModes)
  return {
    snapshotAnsi: info.snapshotAnsi,
    scrollbackAnsi: info.modes.alternateScreen ? info.scrollbackAnsi : '',
    oscLinks: info.oscLinks,
    rehydrateSequences: buildRehydrateSequences(modes),
    ...(info.pendingEscapeTailAnsi ? { pendingEscapeTailAnsi: info.pendingEscapeTailAnsi } : {}),
    ...(opts?.frameRestoreAnsi ? { frameRestoreAnsi: opts.frameRestoreAnsi } : {}),
    cwd: info.cwd,
    modes,
    cols: info.cols,
    rows: info.rows,
    scrollbackLines:
      info.scrollbackLines ?? Math.max(0, countAnsiRows(info.scrollbackAnsi) - info.rows),
    ...(info.lastTitle ? { lastTitle: info.lastTitle } : {}),
    ...(opts?.outputSequence !== undefined ? { outputSequence: opts.outputSequence } : {})
  }
}

export async function buildDurableCheckpointSnapshot(opts: {
  liveSnapshot: TerminalSnapshot
  restoreInfo: ColdRestoreInfo | null
  pendingRecords?: readonly PendingOutputRecord[]
  scrollbackRows?: number
}): Promise<TerminalSnapshot> {
  const pendingRecords = opts.pendingRecords ?? []
  if (!opts.restoreInfo && pendingRecords.length === 0) {
    return opts.liveSnapshot
  }
  if (
    opts.restoreInfo &&
    pendingRecords.length === 0 &&
    (opts.scrollbackRows === undefined || opts.scrollbackRows >= DAEMON_RESTORE_SCROLLBACK_ROWS)
  ) {
    return terminalSnapshotFromColdRestore(opts.restoreInfo, {
      outputSequence: opts.liveSnapshot.outputSequence,
      frameRestoreAnsi: opts.liveSnapshot.frameRestoreAnsi,
      liveModes: opts.liveSnapshot.modes
    })
  }

  const emulator = new HeadlessEmulator({
    cols: opts.restoreInfo?.cols ?? opts.liveSnapshot.cols,
    rows: opts.restoreInfo?.rows ?? opts.liveSnapshot.rows,
    scrollback: Math.min(
      opts.scrollbackRows ?? DAEMON_RESTORE_SCROLLBACK_ROWS,
      DAEMON_RESTORE_SCROLLBACK_ROWS
    )
  })
  const replay = new ColdRestoreReplayWriter(emulator)
  try {
    // Why not seed the live window when there is no disk history: pending records
    // are the raw stream. Replaying them on top of the already-truncated live
    // snapshot would duplicate the newest rows and evict the older recoverable ones.
    if (opts.restoreInfo) {
      const base = restoreBaseFrom(opts.restoreInfo)
      for (const segment of [
        base.scrollbackAnsi,
        base.rehydrateSequences,
        base.snapshotAnsi,
        // Why after the snapshot, mirroring terminal-history-seed-segments.ts:
        // undoes the snapshot's own mode trailer so the rebuilt emulator can't
        // re-arm a dead TUI's mouse modes for getSnapshot() to launder forward.
        COLD_RESTORE_SEED_MODE_RESET,
        base.pendingEscapeTailAnsi ?? ''
      ]) {
        if (!(await replay.write(segment))) {
          return opts.liveSnapshot
        }
      }
      emulator.setRestoredOscLinks(base.oscLinks)
      if (base.lastTitle) {
        emulator.setLastTitle(base.lastTitle)
      }
      emulator.setCwd(base.cwd)
    }
    if (!(await replayPendingRecords(replay, pendingRecords))) {
      return opts.liveSnapshot
    }
    const snapshot = emulator.getSnapshot()
    // Why re-apply here too: the rebuilt emulator replayed
    // COLD_RESTORE_SEED_MODE_RESET, but opts.restoreInfo may be absent
    // (pending-records-only rebuild) or the live owner may have re-armed
    // mouse tracking after the checkpoint was written — the live process
    // is always the authority when this function runs (see call sites).
    const modes = opts.restoreInfo
      ? clearStaleColdRestoreMouseModes(snapshot.modes, opts.liveSnapshot.modes)
      : snapshot.modes
    return {
      ...snapshot,
      modes,
      // Why re-derive from the corrected modes: rehydrateSequences came from
      // getSnapshot()'s own (pre-correction) modes, so a live owner's re-armed
      // mouse tracking would otherwise never reach the re-arm sequences, same
      // fixed-point hazard the fast path (terminalSnapshotFromColdRestore)
      // already guards against.
      rehydrateSequences: buildRehydrateSequences(modes),
      ...(opts.liveSnapshot.outputSequence !== undefined
        ? { outputSequence: opts.liveSnapshot.outputSequence }
        : {}),
      ...(opts.liveSnapshot.frameRestoreAnsi && !snapshot.frameRestoreAnsi
        ? { frameRestoreAnsi: opts.liveSnapshot.frameRestoreAnsi }
        : {})
    }
  } catch (error) {
    console.warn('[history] durable snapshot rebuild failed:', error)
    return opts.liveSnapshot
  } finally {
    emulator.dispose()
  }
}

function restoreBaseFrom(restoreInfo: ColdRestoreInfo): RestoreBase {
  return {
    scrollbackAnsi: restoreInfo.modes.alternateScreen ? restoreInfo.scrollbackAnsi : '',
    rehydrateSequences: restoreInfo.rehydrateSequences,
    snapshotAnsi: restoreInfo.snapshotAnsi,
    ...(restoreInfo.pendingEscapeTailAnsi
      ? { pendingEscapeTailAnsi: restoreInfo.pendingEscapeTailAnsi }
      : {}),
    oscLinks: restoreInfo.oscLinks,
    lastTitle: restoreInfo.lastTitle,
    cwd: restoreInfo.cwd,
    cols: restoreInfo.cols,
    rows: restoreInfo.rows
  }
}

async function replayPendingRecords(
  replay: ColdRestoreReplayWriter,
  records: readonly PendingOutputRecord[]
): Promise<boolean> {
  for (const record of records) {
    if (record.kind === 'output') {
      if (!(await replay.write(record.data))) {
        return false
      }
      continue
    }
    if (record.kind === 'resize') {
      if (!isValidTerminalHistorySize(record.cols, record.rows)) {
        return false
      }
      await replay.resize(record.cols, record.rows)
      continue
    }
    await replay.clearScrollback()
  }
  return true
}

function countAnsiRows(ansi: string): number {
  if (ansi.length === 0) {
    return 0
  }
  return ansi.split(/\r\n|\n|\r/).filter((row) => row.length > 0).length
}
