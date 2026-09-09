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
    liveHookReportOfSessionElsewhere: false,
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

  it('(C) current-generation holder + every death signal -> refused current_generation', () => {
    const incumbents: HolderAdoptionInput['incumbent'][] = [
      { dead: true, signal: 'IDENTITY', evidence: {} as never },
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

  it('D-R163 M2: IDENTITY with a live hook report of X elsewhere -> refused death_signal_insufficient (not just GEN_ABSENCE)', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'IDENTITY', evidence: {} as never },
        liveHookReportOfSessionElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('D-R163 M2: D1 with a live hook report of X elsewhere -> refused death_signal_insufficient (not just GEN_ABSENCE)', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: true, signal: 'D1', evidence: {} as never },
        liveHookReportOfSessionElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
  })

  it('GEN_ABSENCE with a live hook report of X elsewhere -> refused death_signal_insufficient', () => {
    const result = resolveHolderAdoption(
      baseInput({
        incumbent: { dead: false, reason: 'inventory_unknown' },
        liveHookReportOfSessionElsewhere: true
      })
    )
    expect(result).toEqual({ adoptable: false, reason: 'death_signal_insufficient' })
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
})
