// S10-21d b3: dead-holder-adoption predicate — the negatives are the deliverable (framing B's
// attack list). Pure function, no DB/IO.
import { describe, expect, it } from 'vitest'
import { resolveHolderAdoption, type HolderAdoptionInput } from './dead-holder-adoption'

const LOCAL = 'local'

function baseInput(overrides: Partial<HolderAdoptionInput> = {}): HolderAdoptionInput {
  return {
    holderPaneKey: 'tab1:leaf-holder',
    adoptingPaneKey: 'tab2:leaf-new',
    holderExecutionHostId: LOCAL,
    adoptingExecutionHostId: LOCAL,
    holderLaunchGeneration: 'gen-0',
    currentLaunchGeneration: 'gen-1',
    incumbent: { dead: true, signal: 'IDENTITY', evidence: {} as never },
    d2Inventory: 'absent',
    inventoryRoundNonNull: true,
    holderHasConnectedPty: false,
    holderSettledNotLive: true,
    liveHookReportOfSessionOnLivePaneElsewhere: false,
    sweepLockHeld: false,
    sweepRestoreMarkSetForHolder: false,
    holderHasOtherLiveRegisteredRow: false,
    transcriptPreflightPassed: true,
    ...overrides
  }
}

describe('S10-21d b3: resolveHolderAdoption', () => {
  it('IDENTITY on a prior generation -> adoptable', () => {
    expect(resolveHolderAdoption(baseInput())).toEqual({ adoptable: true, signal: 'IDENTITY' })
  })

  it('D1 on a prior generation -> adoptable', () => {
    const result = resolveHolderAdoption(
      baseInput({ incumbent: { dead: true, signal: 'D1', evidence: {} as never } })
    )
    expect(result).toEqual({ adoptable: true, signal: 'D1' })
  })

  it('GEN_ABSENCE (D2 absent, non-null round, no connected pty, no live report elsewhere) -> adoptable', () => {
    const result = resolveHolderAdoption(
      baseInput({ incumbent: { dead: false, reason: 'inventory_unknown' } })
    )
    expect(result).toEqual({ adoptable: true, signal: 'GEN_ABSENCE' })
  })

  it('(A) same pane -> refused same_pane', () => {
    const result = resolveHolderAdoption(
      baseInput({ holderPaneKey: 'tab1:leaf-x', adoptingPaneKey: 'tab1:leaf-x' })
    )
    expect(result).toEqual({ adoptable: false, reason: 'same_pane' })
  })

  it('(B) holder on a different execution host -> refused cross_execution_host', () => {
    const result = resolveHolderAdoption(baseInput({ holderExecutionHostId: 'ssh:remote-1' }))
    expect(result).toEqual({ adoptable: false, reason: 'cross_execution_host' })
  })

  it('(B) adopting pane on a different execution host -> refused cross_execution_host', () => {
    const result = resolveHolderAdoption(baseInput({ adoptingExecutionHostId: 'ssh:remote-1' }))
    expect(result).toEqual({ adoptable: false, reason: 'cross_execution_host' })
  })

  it('(C) holder has no launch row -> refused holder_launch_row_missing', () => {
    const result = resolveHolderAdoption(baseInput({ holderLaunchGeneration: null }))
    expect(result).toEqual({ adoptable: false, reason: 'holder_launch_row_missing' })
  })

  // [S10-21f b2-10q R142, SCENARIO_CORRECTION] Was: `IDENTITY` included in this loop, asserting
  // `current_generation` for every death signal unconditionally. R142 makes an IDENTITY-signal
  // same-generation holder adoptable under its own stricter proof (see the dedicated R142 tests
  // below) — D1/D2/D3 still refuse `current_generation` exactly as before; only IDENTITY's
  // blanket refusal is now conditional, so it moved out of this loop rather than staying wrong.
  it('(C) current-generation holder + every non-IDENTITY death signal -> refused current_generation', () => {
    const incumbents: HolderAdoptionInput['incumbent'][] = [
      { dead: true, signal: 'D1', evidence: {} as never },
      { dead: true, signal: 'D2', evidence: {} as never },
      { dead: true, signal: 'D3', evidence: {} as never }
    ]
    for (const incumbent of incumbents) {
      const result = resolveHolderAdoption(
        baseInput({ holderLaunchGeneration: 'gen-1', incumbent })
      )
      expect(result).toEqual({ adoptable: false, reason: 'current_generation' })
    }
  })

  it('D2-only (not full GEN_ABSENCE — a connected pty stands) -> refused death_signal_insufficient', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'D2', evidence: {} as never },
        holderHasConnectedPty: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('D3-only never suffices, even with a non-null round and no connected pty -> refused', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'D3', evidence: {} as never },
        d2Inventory: 'unknown'
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('D-R163 M2, D-R170 M7: IDENTITY with a live hook report of X elsewhere -> refused live_report_elsewhere (not just GEN_ABSENCE)', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'IDENTITY', evidence: {} as never },
        liveHookReportOfSessionOnLivePaneElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'live_report_elsewhere' })
  })

  it('D-R163 M2, D-R170 M7: D1 with a live hook report of X elsewhere -> refused live_report_elsewhere (not just GEN_ABSENCE)', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'D1', evidence: {} as never },
        liveHookReportOfSessionOnLivePaneElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'live_report_elsewhere' })
  })

  it('D-R170 M7: GEN_ABSENCE with a live hook report of X elsewhere -> refused live_report_elsewhere', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: false, reason: 'inventory_unknown' },
        liveHookReportOfSessionOnLivePaneElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'live_report_elsewhere' })
  })

  it('GEN_ABSENCE with a null inventory round -> refused death_signal_insufficient', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: false, reason: 'inventory_unknown' },
        inventoryRoundNonNull: false
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('GEN_ABSENCE with a connected pty on the holder -> refused death_signal_insufficient', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: false, reason: 'inventory_unknown' },
        holderHasConnectedPty: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('incumbent alive (and GEN_ABSENCE data agrees: present in inventory, connected pty) -> refused death_signal_insufficient', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: false, reason: 'live' },
        d2Inventory: 'present',
        holderHasConnectedPty: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('(E) sweep lock held -> refused sweep_in_flight', () => {
    const result = resolveHolderAdoption(baseInput({ sweepLockHeld: true }))
    expect(result).toEqual({ adoptable: false, reason: 'sweep_in_flight' })
  })

  it('(E) sweep restore mark set for the holder -> refused sweep_in_flight', () => {
    const result = resolveHolderAdoption(baseInput({ sweepRestoreMarkSetForHolder: true }))
    expect(result).toEqual({ adoptable: false, reason: 'sweep_in_flight' })
  })

  it('(F) holder has another live registered row -> refused other_live_registered_row', () => {
    const result = resolveHolderAdoption(baseInput({ holderHasOtherLiveRegisteredRow: true }))
    expect(result).toEqual({ adoptable: false, reason: 'other_live_registered_row' })
  })

  it('(G) transcript preflight failed -> refused transcript_preflight_failed', () => {
    const result = resolveHolderAdoption(baseInput({ transcriptPreflightPassed: false }))
    expect(result).toEqual({ adoptable: false, reason: 'transcript_preflight_failed' })
  })

  // [S10-21f b2-10q R143] `liveHookReportOfSessionOnLivePaneElsewhere` is the caller's own
  // already-discounted boolean (live-report-liveness.ts decides the discount; this predicate only
  // reads the result), so these prove the RENAMED field still gates identically to the old one,
  // plus the new `detail`/`liveReportReporterPaneKeys` wiring.
  it('R143: liveHookReportOfSessionOnLivePaneElsewhere false (the caller already discounted a dead reporter) -> adoptable', () => {
    const result = resolveHolderAdoption(
      baseInput({
        liveHookReportOfSessionOnLivePaneElsewhere: false,
        liveReportReporterPaneKeys: ['tab-dead-reporter:leaf']
      })
    )
    expect(result).toEqual({ adoptable: true, signal: 'IDENTITY' })
  })

  it('R143: refusal detail names the reporter pane(s) when supplied', () => {
    const result = resolveHolderAdoption(
      baseInput({
        liveHookReportOfSessionOnLivePaneElsewhere: true,
        liveReportReporterPaneKeys: ['tab-live-reporter:leaf']
      })
    )
    expect(result).toEqual({
      adoptable: false,
      reason: 'live_report_elsewhere',
      detail: 'reporter_panes=tab-live-reporter:leaf'
    })
  })

  it('R143: refusal has no detail when no reporter pane keys are supplied', () => {
    const result = resolveHolderAdoption(
      baseInput({ liveHookReportOfSessionOnLivePaneElsewhere: true })
    )
    expect(result).toEqual({ adoptable: false, reason: 'live_report_elsewhere' })
  })

  // [S10-21f b2-10q R142] Same-generation dead holder: the launcher itself minted this
  // generation, so only the strictest proof (identity-death + D2/pty-absence + D3 settle) admits
  // adoption — anything less refuses, never falling back to D1/GEN_ABSENCE's looser bar.
  function sameGenInput(overrides: Partial<HolderAdoptionInput> = {}): HolderAdoptionInput {
    return baseInput({
      holderLaunchGeneration: 'gen-same',
      currentLaunchGeneration: 'gen-same',
      incumbent: { dead: true, signal: 'IDENTITY', evidence: {} as never },
      d2Inventory: 'absent',
      inventoryRoundNonNull: true,
      holderHasConnectedPty: false,
      holderSettledNotLive: true,
      ...overrides
    })
  }

  it('R142: same generation + IDENTITY dead + absent + settled -> adoptable SAME_GEN_PTY_ABSENCE', () => {
    const result = resolveHolderAdoption(sameGenInput())
    expect(result).toEqual({ adoptable: true, signal: 'SAME_GEN_PTY_ABSENCE' })
  })

  it('R142: same generation with a connected holder pty -> refused current_generation', () => {
    const result = resolveHolderAdoption(sameGenInput({ holderHasConnectedPty: true }))
    expect(result).toEqual({ adoptable: false, reason: 'current_generation' })
  })

  it('R142: same generation with D2 not absent -> refused current_generation', () => {
    const result = resolveHolderAdoption(sameGenInput({ d2Inventory: 'unknown' }))
    expect(result).toEqual({ adoptable: false, reason: 'current_generation' })
  })

  it('R142: same generation with a null inventory round -> refused current_generation', () => {
    const result = resolveHolderAdoption(sameGenInput({ inventoryRoundNonNull: false }))
    expect(result).toEqual({ adoptable: false, reason: 'current_generation' })
  })

  it('R142: same generation with a non-IDENTITY death signal (D1) -> refused current_generation', () => {
    const result = resolveHolderAdoption(
      sameGenInput({ incumbent: { dead: true, signal: 'D1', evidence: {} as never } })
    )
    expect(result).toEqual({ adoptable: false, reason: 'current_generation' })
  })

  it('R142: same generation, all death proof present but NOT settled -> refused same_generation_settling', () => {
    const result = resolveHolderAdoption(sameGenInput({ holderSettledNotLive: false }))
    // [M2 follow-up] `detail` added: the CLI operator hint to retry after the settle window.
    expect(result).toEqual({
      adoptable: false,
      reason: 'same_generation_settling',
      detail:
        'the holder pane read absent just now; run `orca chairs restore` again in ≥10 s to confirm'
    })
  })

  it('R142: a live hook report elsewhere still refuses a same-generation holder FIRST (conjunct D order unchanged)', () => {
    const result = resolveHolderAdoption(
      sameGenInput({ liveHookReportOfSessionOnLivePaneElsewhere: true })
    )
    expect(result).toEqual({ adoptable: false, reason: 'live_report_elsewhere' })
  })
})
