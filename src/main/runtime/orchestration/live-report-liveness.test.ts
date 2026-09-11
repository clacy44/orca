// S10-21f b2-10q R143: liveReportOnLivePaneElsewhere — pure, no DB/IO.
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  liveReportOnLivePaneElsewhere,
  liveReportStandsElsewhere,
  type LiveReportPaneReporter,
  type LiveReportRuntimeDeps
} from './live-report-liveness'
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

// [S10-21f b2b-10q M3] Direct tests for the caller-facing wrapper — the fixtures above already
// prove `liveReportOnLivePaneElsewhere`'s own boolean logic against its resolver callbacks;
// these prove the wrapper's own two resolution steps (findConnectedPtyForPane, then
// getPersistedPtyIdForLeaf) and its `reporters === null` fail-closed default.
describe('S10-21f b2b-10q M3: liveReportStandsElsewhere', () => {
  function deps(overrides: Partial<LiveReportRuntimeDeps> = {}): LiveReportRuntimeDeps {
    return {
      findConnectedPtyForPane: () => undefined,
      getPersistedPtyIdForLeaf: () => undefined,
      ...overrides
    }
  }

  it('reporters === null (the pane-granular accessor unwired) -> stands (true)', () => {
    expect(liveReportStandsElsewhere(null, inventoryWithLive(), 'local', deps())).toBe(true)
  })

  it('a connected pty present through the real resolver -> stands (true)', () => {
    const reporters: LiveReportPaneReporter[] = [{ paneKey: 'tab:leaf', executionHostId: LOCAL }]
    expect(
      liveReportStandsElsewhere(
        reporters,
        inventoryWithLive('pty-connected'),
        'local',
        deps({ findConnectedPtyForPane: () => ({ ptyId: 'pty-connected' }) })
      )
    ).toBe(true)
  })

  it('no connected pty, but a persisted-only ptyId PRESENT in the round -> stands (true)', () => {
    const paneKey = `tab1:${randomUUID()}`
    const reporters: LiveReportPaneReporter[] = [{ paneKey, executionHostId: LOCAL }]
    expect(
      liveReportStandsElsewhere(
        reporters,
        inventoryWithLive('pty-persisted'),
        'local',
        deps({ getPersistedPtyIdForLeaf: () => 'pty-persisted' })
      )
    ).toBe(true)
  })

  // [D-R185 finding 2, NEXT-train tightening] Pinning the CURRENT behaviour, not endorsing it: a
  // persisted-only ptyId absent from a non-null round discounts the report exactly like a
  // connected one would — the reporter pane's OWN liveness (distinct from the ptyId's) is not
  // re-checked here. Left as-is for this train; D-R185 finding 2 names it as the next tightening.
  it('no connected pty, persisted-only ptyId ABSENT from a non-null round -> discounted (false)', () => {
    const paneKey = `tab1:${randomUUID()}`
    const reporters: LiveReportPaneReporter[] = [{ paneKey, executionHostId: LOCAL }]
    expect(
      liveReportStandsElsewhere(
        reporters,
        inventoryWithLive(),
        'local',
        deps({ getPersistedPtyIdForLeaf: () => 'pty-persisted' })
      )
    ).toBe(false)
  })
})
