import { describe, expect, it } from 'vitest'
import { resolveClaudeAccountSwitchRestartHedge } from './claude-account-switch-restart-hedge'

describe('resolveClaudeAccountSwitchRestartHedge', () => {
  // R2: a lane re-resolves the new account live, so there is nothing to restart.
  it('needs no restart when every live terminal is a re-resolving lane', () => {
    expect(
      resolveClaudeAccountSwitchRestartHedge([
        { onLane: true, laneState: 'loaded' },
        { onLane: true, laneState: 'absent' },
        { onLane: true, laneState: 'reauth-required' }
      ])
    ).toBe('none')
  })

  // §2h degraded path: the §4 live-probe fallback cannot switch in place.
  it('requires a restart when a lane fell back to restart-required', () => {
    expect(
      resolveClaudeAccountSwitchRestartHedge([
        { onLane: true, laneState: 'loaded' },
        { onLane: true, laneState: 'restart-required' }
      ])
    ).toBe('required')
  })

  // The pre-S9 shared credential does not re-resolve — the case the unconditional hedge was for.
  it('requires a restart for a shared/host terminal that is not on a lane', () => {
    expect(resolveClaudeAccountSwitchRestartHedge([{ onLane: false }])).toBe('required')
  })

  // With no live terminals at all there is nothing to hedge about.
  it('needs no restart when nothing is live', () => {
    expect(resolveClaudeAccountSwitchRestartHedge([])).toBe('none')
  })

  // A lane with no explicit state re-resolves live like any other non-fallback lane.
  it('treats a lane with an unstated state as re-resolving', () => {
    expect(resolveClaudeAccountSwitchRestartHedge([{ onLane: true }])).toBe('none')
  })
})
