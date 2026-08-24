import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import { resolveClaudeAccountSwitchLiveTerminals } from './claude-account-switch-live-terminals'
import { resolveClaudeAccountSwitchRestartHedge } from './claude-account-switch-restart-hedge'

function summary(overrides: Partial<RuntimeTerminalSummary>): RuntimeTerminalSummary {
  return {
    handle: 'h',
    ptyId: 'p',
    worktreeId: 'w',
    worktreePath: '/w',
    branch: 'main',
    tabId: 't',
    leafId: 'l',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('resolveClaudeAccountSwitchLiveTerminals', () => {
  it('marks a grant lane as on-lane and carries its residency', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'grant', laneState: 'loaded' })
    ])
    expect(live).toEqual([{ onLane: true, laneState: 'loaded' }])
  })

  it('marks host and shared-runtime lanes as off-lane (pre-S9 restart case)', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'host' }),
      summary({ credentialLane: 'shared-runtime' })
    ])
    expect(live).toEqual([{ onLane: false }, { onLane: false }])
  })

  it('excludes remote, wsl, unknown and non-lane terminals so they never force a restart', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'remote' }),
      summary({ credentialLane: 'wsl' }),
      summary({ credentialLane: 'unknown' }),
      summary({ credentialLane: undefined })
    ])
    expect(live).toEqual([])
  })

  it('drops an unmodelled residency (restart-required is not on the wire yet)', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'grant', laneState: undefined })
    ])
    expect(live).toEqual([{ onLane: true }])
  })

  it('feeds the classifier: all grant lanes re-resolve live, so no hedge', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'grant', laneState: 'loaded' }),
      summary({ credentialLane: 'grant', laneState: 'reauth-required' })
    ])
    expect(resolveClaudeAccountSwitchRestartHedge(live)).toBe('none')
  })

  it('feeds the classifier: a shared terminal forces the hedge', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([
      summary({ credentialLane: 'grant', laneState: 'loaded' }),
      summary({ credentialLane: 'host' })
    ])
    expect(resolveClaudeAccountSwitchRestartHedge(live)).toBe('required')
  })

  it('feeds the classifier: a box with only plain shells needs no restart', () => {
    const live = resolveClaudeAccountSwitchLiveTerminals([summary({ credentialLane: undefined })])
    expect(resolveClaudeAccountSwitchRestartHedge(live)).toBe('none')
  })
})
