import { describe, expect, it } from 'vitest'
import { buildDurableCheckpointSnapshot } from './daemon-durable-history-snapshot'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import type { TerminalSnapshot } from './types'

// Repro for #12101 (durable-checkpoint half): a checkpoint carrying a
// SIGKILLed TUI's stale mouse/alt-screen DECSET must not launder those bits
// forward as a fixed point — RC1/B1/B2.

const ANY_MOTION_TRACKING_ON = '\x1b[?1003h'
const SGR_ENCODING_ON = '\x1b[?1006h'
const ALT_SCREEN_ON = '\x1b[?1049h'

function coldRestoreInfoFromDeadTui(): ColdRestoreInfo {
  return {
    snapshotAnsi: 'zsh$ ',
    scrollbackAnsi: '',
    rehydrateSequences: `${ALT_SCREEN_ON}${ANY_MOTION_TRACKING_ON}${SGR_ENCODING_ON}`,
    cwd: '/home/dev',
    cols: 80,
    rows: 24,
    modes: {
      bracketedPaste: false,
      mouseTracking: true,
      mouseTrackingMode: 'any',
      sgrMouseMode: true,
      sgrMousePixelsMode: false,
      applicationCursor: false,
      alternateScreen: true
    }
  }
}

function baseLiveSnapshot(): TerminalSnapshot {
  return {
    snapshotAnsi: '',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: null,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    cols: 80,
    rows: 24,
    scrollbackLines: 0
  }
}

describe('buildDurableCheckpointSnapshot mode-fixed-point (#12101)', () => {
  it('rebuild branch: a checkpoint with stale mouse/alt DECSET rebuilds with mouseTracking=false', async () => {
    const snapshot = await buildDurableCheckpointSnapshot({
      liveSnapshot: baseLiveSnapshot(),
      restoreInfo: coldRestoreInfoFromDeadTui(),
      // Why a resize record forces the rebuild branch (not the verbatim fast path).
      pendingRecords: [{ kind: 'resize', cols: 80, rows: 24 }]
    })

    expect(snapshot.modes.mouseTracking).toBe(false)
    expect(snapshot.rehydrateSequences).not.toContain(ANY_MOTION_TRACKING_ON)
    expect(snapshot.rehydrateSequences).not.toContain(SGR_ENCODING_ON)
  })

  it('fast path: a checkpoint with stale mouse DECSET is not laundered verbatim', async () => {
    const snapshot = await buildDurableCheckpointSnapshot({
      liveSnapshot: baseLiveSnapshot(),
      restoreInfo: coldRestoreInfoFromDeadTui(),
      // Why: no pendingRecords and scrollbackRows at/above the floor selects
      // the fast path (terminalSnapshotFromColdRestore), not the rebuild.
      scrollbackRows: DAEMON_RESTORE_SCROLLBACK_ROWS
    })

    expect(snapshot.modes.mouseTracking).toBe(false)
    expect(snapshot.modes.mouseTrackingMode).toBe('none')
    expect(snapshot.rehydrateSequences).not.toContain(ANY_MOTION_TRACKING_ON)
    expect(snapshot.rehydrateSequences).not.toContain(SGR_ENCODING_ON)
    // Alt-screen content is still recoverable — only mouse bits are untrusted.
    expect(snapshot.rehydrateSequences).toContain(ALT_SCREEN_ON)
    expect(snapshot.modes.alternateScreen).toBe(true)
  })
})
