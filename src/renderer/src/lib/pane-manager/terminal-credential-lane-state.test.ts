import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNATTRIBUTED_CREDENTIAL_LANE,
  applyTerminalCredentialLaneRows,
  clearCredentialLaneScope,
  getCredentialLaneForPty,
  onCredentialLaneChange,
  resetTerminalCredentialLaneStateForTest,
  setCredentialLaneForPty,
  type TerminalPaneCredentialLane
} from './terminal-credential-lane-state'

function lane(overrides: Partial<TerminalPaneCredentialLane> = {}): TerminalPaneCredentialLane {
  return { credentialLane: 'grant', laneState: 'loaded', ...overrides }
}

describe('terminal credential lane pane state', () => {
  beforeEach(() => {
    resetTerminalCredentialLaneStateForTest()
  })

  it('returns the unattributed default for a pane no row ever named', () => {
    // The fail-closed rule: a pane with no lane row reads `unknown`, never a person's lane.
    expect(getCredentialLaneForPty('pty-absent')).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
    expect(getCredentialLaneForPty('pty-absent').credentialLane).toBe('unknown')
  })

  it('hands every unattributed pane the same frozen identity', () => {
    // Why identity: the chip selector reads this per pane on every list write, so the empty answer
    // must cost nothing and compare equal across panes.
    expect(getCredentialLaneForPty('pty-a')).toBe(getCredentialLaneForPty('pty-b'))
  })

  it('stores a pane lane and notifies listeners with the resolved value', () => {
    const seen: { ptyId: string; credentialLane: string }[] = []
    const unsubscribe = onCredentialLaneChange((event) => {
      seen.push({ ptyId: event.ptyId, credentialLane: event.lane.credentialLane })
    })

    setCredentialLaneForPty('pty-1', lane({ credentialLane: 'grant', laneState: 'loaded' }))

    expect(getCredentialLaneForPty('pty-1').credentialLane).toBe('grant')
    expect(getCredentialLaneForPty('pty-1').laneState).toBe('loaded')
    expect(seen).toEqual([{ ptyId: 'pty-1', credentialLane: 'grant' }])
    unsubscribe()
  })

  it('updates a pane lane in place when its row changes', () => {
    applyTerminalCredentialLaneRows('env-1', [
      { ptyId: 'pty-1', lane: lane({ laneState: 'absent' }) }
    ])
    expect(getCredentialLaneForPty('pty-1').laneState).toBe('absent')

    applyTerminalCredentialLaneRows('env-1', [
      { ptyId: 'pty-1', lane: lane({ laneState: 'reauth-required' }) }
    ])
    expect(getCredentialLaneForPty('pty-1').laneState).toBe('reauth-required')
  })

  it('drops a stale row a later list for the same scope no longer carries', () => {
    applyTerminalCredentialLaneRows('env-1', [
      { ptyId: 'pty-1', lane: lane() },
      { ptyId: 'pty-2', lane: lane() }
    ])
    expect(getCredentialLaneForPty('pty-1').credentialLane).toBe('grant')
    expect(getCredentialLaneForPty('pty-2').credentialLane).toBe('grant')

    // pty-2 left the list — it must stop asserting a lane rather than freeze on its last chip.
    applyTerminalCredentialLaneRows('env-1', [{ ptyId: 'pty-1', lane: lane() }])

    expect(getCredentialLaneForPty('pty-1').credentialLane).toBe('grant')
    expect(getCredentialLaneForPty('pty-2')).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
  })

  it('never lets one scope stale-drop another scope current rows', () => {
    applyTerminalCredentialLaneRows('env-1', [{ ptyId: 'pty-1', lane: lane() }])
    applyTerminalCredentialLaneRows('env-2', [{ ptyId: 'pty-2', lane: lane() }])

    // A fresh env-1 list that never named pty-1 clears env-1 alone.
    applyTerminalCredentialLaneRows('env-1', [])

    expect(getCredentialLaneForPty('pty-1')).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
    expect(getCredentialLaneForPty('pty-2').credentialLane).toBe('grant')
  })

  it('clears every pane a scope carried when the environment pairs out', () => {
    applyTerminalCredentialLaneRows('env-1', [
      { ptyId: 'pty-1', lane: lane() },
      { ptyId: 'pty-2', lane: lane() }
    ])

    clearCredentialLaneScope('env-1')

    expect(getCredentialLaneForPty('pty-1')).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
    expect(getCredentialLaneForPty('pty-2')).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
  })

  it('does not re-notify a pane that was already unattributed', () => {
    const listener = vi.fn()
    const unsubscribe = onCredentialLaneChange(listener)

    clearCredentialLaneForPtyTwice()

    // Why once at most: a repeat clear on an already-empty pane must not tick every mounted chip.
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('carries the owner flag and usage through to the pane reader', () => {
    setCredentialLaneForPty('pty-1', {
      credentialLane: 'grant',
      laneState: 'loaded',
      laneAccountLabel: { owner: 'Ana', accountName: 'work' },
      laneUsage: { session: null, weekly: null },
      credentialLaneOwner: true
    })

    const read = getCredentialLaneForPty('pty-1')
    expect(read.credentialLaneOwner).toBe(true)
    expect(read.laneAccountLabel).toEqual({ owner: 'Ana', accountName: 'work' })
    expect(read.laneUsage).toEqual({ session: null, weekly: null })
  })
})

function clearCredentialLaneForPtyTwice(): void {
  // A pane nothing ever wrote is already unattributed; clearing it must be a no-op both times.
  const before = getCredentialLaneForPty('pty-never')
  expect(before).toBe(UNATTRIBUTED_CREDENTIAL_LANE)
  applyTerminalCredentialLaneRows('env-x', [])
}
