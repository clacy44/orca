import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import {
  collectTerminalCredentialLaneRows,
  laneFeedScopeKey
} from './terminal-credential-lane-feed'

function summary(overrides: Partial<RuntimeTerminalSummary>): RuntimeTerminalSummary {
  return {
    handle: 'h',
    ptyId: 'pty-1',
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

describe('laneFeedScopeKey', () => {
  it('keys the local target and each environment distinctly', () => {
    expect(laneFeedScopeKey({ kind: 'local' })).toBe('local')
    expect(laneFeedScopeKey({ kind: 'environment', environmentId: 'e1' })).toBe('env:e1')
  })
})

describe('collectTerminalCredentialLaneRows', () => {
  it('maps a summary with a pty id to a lane row, carrying the lane fields', () => {
    const rows = collectTerminalCredentialLaneRows([
      summary({
        ptyId: 'pty-1',
        credentialLane: 'grant',
        laneState: 'loaded',
        laneAccountLabel: { owner: 'Ana', accountName: 'work' }
      })
    ])
    expect(rows).toEqual([
      {
        ptyId: 'pty-1',
        lane: {
          credentialLane: 'grant',
          laneState: 'loaded',
          laneAccountLabel: { owner: 'Ana', accountName: 'work' }
        }
      }
    ])
  })

  it('drops a summary with no pty id', () => {
    expect(collectTerminalCredentialLaneRows([summary({ ptyId: null })])).toEqual([])
  })

  it('defaults an absent credentialLane to unknown', () => {
    const [row] = collectTerminalCredentialLaneRows([summary({ credentialLane: undefined })])
    expect(row.lane.credentialLane).toBe('unknown')
  })

  it('joins credentialLaneOwner from the self participant that owns the lane', () => {
    const [row] = collectTerminalCredentialLaneRows([
      summary({
        credentialLane: 'grant',
        presence: {
          attachedCount: 1,
          participants: [
            {
              participantId: 'me',
              label: 'Ana',
              kind: 'host',
              typing: false,
              writing: false,
              self: true,
              credentialLaneOwner: true
            }
          ]
        }
      })
    ])
    expect(row.lane.credentialLaneOwner).toBe(true)
  })

  it('does not claim ownership for a peer’s owned lane', () => {
    const [row] = collectTerminalCredentialLaneRows([
      summary({
        credentialLane: 'grant',
        presence: {
          attachedCount: 1,
          participants: [
            {
              participantId: 'peer',
              label: 'Boris',
              kind: 'host',
              typing: false,
              writing: false,
              credentialLaneOwner: true
            }
          ]
        }
      })
    ])
    expect(row.lane.credentialLaneOwner).toBeUndefined()
  })
})
