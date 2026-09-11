// S10-21f b2-10q R143: liveReportOnLivePaneElsewhere — pure, no DB/IO.
import { describe, expect, it } from 'vitest'
import { liveReportOnLivePaneElsewhere, type LiveReportPaneReporter } from './live-report-liveness'
import type { ControllerInventory } from './agent-process-identity'

const LOCAL = 'local'
const REMOTE = 'ssh:remote-1'

function inventoryWithLive(...ptyIds: string[]): ControllerInventory {
  return { allLivePtyIds: new Set(ptyIds), terminalIdentityByPtyId: new Map() }
}

describe('S10-21f b2-10q R143: liveReportOnLivePaneElsewhere', () => {
  it('no reporters at all -> false (nothing stands)', () => {
    expect(
      liveReportOnLivePaneElsewhere(
        [],
        inventoryWithLive(),
        () => 'pty-x',
        () => false
      )
    ).toBe(false)
  })

  it('null inventory round -> true, even with zero reporters resolved', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        null,
        () => 'pty-x',
        () => false
      )
    ).toBe(true)
  })

  it('a non-local reporter -> true, regardless of its pty state', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: REMOTE }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive(),
        () => 'pty-x',
        () => false
      )
    ).toBe(true)
  })

  it('no ptyId resolves for the reporter pane -> true', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive(),
        () => undefined,
        () => false
      )
    ).toBe(true)
  })

  it('resolved ptyId + non-null round + present in round -> true', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive('pty-x'),
        () => 'pty-x',
        () => false
      )
    ).toBe(true)
  })

  it('resolved ptyId + absent from the round but connected NOW -> true (union, not the round alone)', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive(),
        () => 'pty-x',
        () => true
      )
    ).toBe(true)
  })

  it('resolved ptyId + non-null round + absent + not connected now -> false (discounted)', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive(),
        () => 'pty-x',
        () => false
      )
    ).toBe(false)
  })

  it('one discounted reporter and one live reporter -> true (any reporter standing wins)', () => {
    const reporters: LiveReportPaneReporter[] = [
      { paneKey: 'tab:dead-reporter', executionHostId: LOCAL },
      { paneKey: 'tab:live-reporter', executionHostId: LOCAL }
    ]
    expect(
      liveReportOnLivePaneElsewhere(
        reporters,
        inventoryWithLive('pty-live'),
        (paneKey) => (paneKey === 'tab:live-reporter' ? 'pty-live' : 'pty-dead'),
        () => false
      )
    ).toBe(true)
  })
})
