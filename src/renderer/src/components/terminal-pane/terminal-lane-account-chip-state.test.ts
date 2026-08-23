import { describe, expect, it } from 'vitest'
import { resolveTerminalLaneAccountChipState } from './terminal-lane-account-chip-state'

const window = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt: null,
  resetDescription: null
})

describe('resolveTerminalLaneAccountChipState', () => {
  it('joins the owner label with the pushed account name', () => {
    expect(
      resolveTerminalLaneAccountChipState({
        laneAccountLabel: { owner: 'Ana', accountName: 'work' }
      })
    ).toEqual({ label: 'Ana · work' })
  })

  it('falls back to the owner alone when no account name was pushed', () => {
    expect(resolveTerminalLaneAccountChipState({ laneAccountLabel: { owner: 'Ana' } })).toEqual({
      label: 'Ana'
    })
  })

  it('shows the tighter of the two windows', () => {
    expect(
      resolveTerminalLaneAccountChipState({
        laneAccountLabel: { owner: 'Ana' },
        laneUsage: { session: window(12), weekly: window(74.4) }
      })?.usedPercent
    ).toBe(74)
  })

  // §2d: a peer's row carries the label and no bar, and the chip must render no bar rather than 0%.
  it('renders no percentage when the usage row is omitted', () => {
    expect(
      resolveTerminalLaneAccountChipState({ laneAccountLabel: { owner: 'Ana' } })
    ).not.toHaveProperty('usedPercent')
  })

  it('says why there is no bar instead of showing a stale one', () => {
    expect(
      resolveTerminalLaneAccountChipState({
        laneAccountLabel: { owner: 'Ana' },
        laneUsage: {
          session: window(90),
          weekly: null,
          unavailableReason: 'usage unavailable on this host'
        }
      })
    ).toEqual({ label: 'Ana', unavailableReason: 'usage unavailable on this host' })
  })

  it('renders nothing at all for a row with no lane owner', () => {
    expect(resolveTerminalLaneAccountChipState({})).toBeNull()
    expect(resolveTerminalLaneAccountChipState({ laneAccountLabel: { owner: '' } })).toBeNull()
  })
})
