import { describe, expect, it, vi } from 'vitest'
import type { TerminalPresenceParticipant } from './terminal-presence-registry'
import { createPresenceParticipantPrincipalResolver } from './presence-participant-principal'

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'

function participant(
  participantId: string,
  pairedDeviceId: string
): [string, TerminalPresenceParticipant] {
  return [
    `conn-${participantId}`,
    {
      participantId,
      pairedDeviceId,
      label: pairedDeviceId,
      kind: 'mobile',
      connectedAt: 0,
      lastInboundAt: 0
    }
  ]
}

describe('createPresenceParticipantPrincipalResolver', () => {
  const connections = () =>
    new Map([participant('p-a', 'device-a'), participant('p-b', 'device-b')])
  const principalOfGrant = (grant: string): string | null =>
    grant === 'device-a' ? PRINCIPAL_A : null

  it('resolves the person behind a participant through their grant', () => {
    const resolve = createPresenceParticipantPrincipalResolver({ connections, principalOfGrant })

    expect(resolve('p-a')).toBe(PRINCIPAL_A)
  })

  it('answers null for an unbound grant and for a participant nobody holds', () => {
    const resolve = createPresenceParticipantPrincipalResolver({ connections, principalOfGrant })

    expect(resolve('p-b')).toBeNull()
    expect(resolve('p-nobody')).toBeNull()
  })

  it('walks the connection map once, however many rows ask', () => {
    const walk = vi.fn(connections)
    const grants = vi.fn(principalOfGrant)
    const resolve = createPresenceParticipantPrincipalResolver({
      connections: walk,
      principalOfGrant: grants
    })

    for (let row = 0; row < 5; row += 1) {
      expect(resolve('p-a')).toBe(PRINCIPAL_A)
      expect(resolve('p-b')).toBeNull()
    }

    expect(walk).toHaveBeenCalledTimes(1)
    expect(grants).toHaveBeenCalledTimes(2)
  })
})
