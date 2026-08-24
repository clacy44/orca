import { describe, expect, it } from 'vitest'
import { shouldOfferOpenInMyLane, viewerOwnsCredentialLane } from './terminal-open-in-lane-action'
import type { TerminalCredentialLaneAttribution } from './terminal-credential-lane-attribution'
import type { TerminalPresenceParticipant } from '@/lib/pane-manager/terminal-presence-state'

const owned: TerminalCredentialLaneAttribution = {
  kind: 'owned',
  account: { label: 'Ana · work' }
}

const participant = (
  over: Partial<TerminalPresenceParticipant> = {}
): TerminalPresenceParticipant => ({
  participantId: 'p1',
  label: 'Ana',
  kind: 'runtime',
  typing: false,
  writing: false,
  ...over
})

describe('viewerOwnsCredentialLane', () => {
  it('is true only when the viewer is themselves the lane owner', () => {
    expect(viewerOwnsCredentialLane([participant({ self: true, credentialLaneOwner: true })])).toBe(
      true
    )
  })

  // §2h: the owner label can sit on a peer's participant; the viewer does not own it then.
  it('is false when the lane owner is someone else', () => {
    expect(
      viewerOwnsCredentialLane([
        participant({ participantId: 'peer', credentialLaneOwner: true }),
        participant({ participantId: 'me', self: true })
      ])
    ).toBe(false)
  })

  it('is false when nobody is marked the owner', () => {
    expect(viewerOwnsCredentialLane([participant({ self: true })])).toBe(false)
  })
})

describe('shouldOfferOpenInMyLane', () => {
  // Capability gate (mutation proof): drop the capability check and the affordance shows on an
  // older host that has no `terminal.openInMyLane` method at all.
  it('is hidden when the host does not advertise the lanes capability', () => {
    expect(
      shouldOfferOpenInMyLane({
        capabilitySupported: false,
        attribution: owned,
        viewerOwnsLane: false
      })
    ).toBe(false)
  })

  it('is offered on another person’s owned lane when the capability is present', () => {
    expect(
      shouldOfferOpenInMyLane({
        capabilitySupported: true,
        attribution: owned,
        viewerOwnsLane: false
      })
    ).toBe(true)
  })

  // Mutation proof: drop the `owned` check and it offers on a shared/remote row with no lane.
  it.each<TerminalCredentialLaneAttribution>([
    { kind: 'shared', source: 'host' },
    { kind: 'shared', source: 'runtime' },
    { kind: 'labelled', laneKind: 'remote' },
    { kind: 'labelled', laneKind: 'wsl' },
    { kind: 'unattributed' }
  ])('is hidden on a $kind row that names no person', (attribution) => {
    expect(
      shouldOfferOpenInMyLane({ capabilitySupported: true, attribution, viewerOwnsLane: false })
    ).toBe(false)
  })

  // Mutation proof: drop the `viewerOwnsLane` check and it offers on the viewer's own terminal.
  it('is hidden on the viewer’s own lane', () => {
    expect(
      shouldOfferOpenInMyLane({
        capabilitySupported: true,
        attribution: owned,
        viewerOwnsLane: true
      })
    ).toBe(false)
  })
})
