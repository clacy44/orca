import { describe, expect, it } from 'vitest'
import type { TerminalPaneCredentialLane } from '@/lib/pane-manager/terminal-credential-lane-state'
import { resolveTabCredentialLaneOwnerLabel } from './terminal-tab-credential-lane-owner'

describe('resolveTabCredentialLaneOwnerLabel', () => {
  it('returns the owner+account label of the first owned lane', () => {
    const lanes: TerminalPaneCredentialLane[] = [
      { credentialLane: 'host' },
      { credentialLane: 'grant', laneAccountLabel: { owner: 'Ana', accountName: 'work' } }
    ]
    expect(resolveTabCredentialLaneOwnerLabel(lanes)).toBe('Ana · work')
  })

  it('returns null when no pane runs on a person’s lane', () => {
    expect(
      resolveTabCredentialLaneOwnerLabel([
        { credentialLane: 'host' },
        { credentialLane: 'remote' },
        { credentialLane: 'unknown' }
      ])
    ).toBeNull()
  })

  it('returns null for an owned lane whose owner did not resolve', () => {
    expect(resolveTabCredentialLaneOwnerLabel([{ credentialLane: 'grant' }])).toBeNull()
  })
})
