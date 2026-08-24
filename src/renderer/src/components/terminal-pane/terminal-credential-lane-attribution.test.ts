import { describe, expect, it } from 'vitest'
import { resolveTerminalCredentialLaneAttribution } from './terminal-credential-lane-attribution'

const usage = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 300,
  resetsAt: null,
  resetDescription: null
})

describe('resolveTerminalCredentialLaneAttribution', () => {
  // §2h: `'grant'` is pinned to a principal's lane, so it renders the owner label.
  it('attributes a grant lane to its owner, joined with the pushed account name', () => {
    expect(
      resolveTerminalCredentialLaneAttribution({
        credentialLane: 'grant',
        laneAccountLabel: { owner: 'Ana', accountName: 'work' }
      })
    ).toEqual({ kind: 'owned', account: { label: 'Ana · work' } })
  })

  // Mutation proof: the caller's own lane carries a usage bar; drop the usage forwarding and this
  // percentage disappears.
  it('carries the usage bar through for an owned lane', () => {
    const attribution = resolveTerminalCredentialLaneAttribution({
      credentialLane: 'grant',
      laneAccountLabel: { owner: 'Ana' },
      laneUsage: { session: usage(12), weekly: usage(80) }
    })
    expect(attribution).toEqual({ kind: 'owned', account: { label: 'Ana', usedPercent: 80 } })
  })

  // §2h fail-closed: a grant row the host could not join to a person is never attributed.
  it('renders a grant with no owner label as unattributed, not owned', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'grant' })).toEqual({
      kind: 'unattributed'
    })
  })

  it('renders the shared host lane as shared/host', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'host' })).toEqual({
      kind: 'shared',
      source: 'host'
    })
  })

  // §2a consequence 3: the OpenClaude downgrade renders as shared, never as owned.
  it('renders a shared-runtime downgrade as shared/runtime', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'shared-runtime' })).toEqual({
      kind: 'shared',
      source: 'runtime'
    })
  })

  it('labels a remote pane for where it runs', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'remote' })).toEqual({
      kind: 'labelled',
      laneKind: 'remote'
    })
  })

  it('labels a WSL pane for where it runs', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'wsl' })).toEqual({
      kind: 'labelled',
      laneKind: 'wsl'
    })
  })

  // §2h: a pre-S9 restored pane publishes no credentialLane and must never be attributed.
  it('renders an unknown lane and an absent field alike as unattributed', () => {
    expect(resolveTerminalCredentialLaneAttribution({ credentialLane: 'unknown' })).toEqual({
      kind: 'unattributed'
    })
    expect(resolveTerminalCredentialLaneAttribution({})).toEqual({ kind: 'unattributed' })
  })

  // A shared-runtime or labelled row is not running on the lane, so an account label on the wire
  // must not promote it back to owned.
  it('ignores a stray lane account label on a non-grant row', () => {
    expect(
      resolveTerminalCredentialLaneAttribution({
        credentialLane: 'shared-runtime',
        laneAccountLabel: { owner: 'Ana', accountName: 'work' }
      })
    ).toEqual({ kind: 'shared', source: 'runtime' })
  })
})
