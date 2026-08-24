import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  assertLaneSeedPromptWithinBounds,
  callerMayOpenSourceLane,
  MAX_LANE_SEED_PROMPT_BYTES
} from './terminal-open-in-lane'
import { TerminalPresenceRegistry } from './terminal-presence-registry'

function refusalCode(fn: () => void): string | null {
  try {
    fn()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `unexpected:${String(error)}`
  }
  return null
}

describe('assertLaneSeedPromptWithinBounds', () => {
  it('accepts plain text and newlines', () => {
    expect(
      refusalCode(() => assertLaneSeedPromptWithinBounds('fix the bug\nin runtime'))
    ).toBeNull()
  })

  it('rejects a prompt over the byte budget', () => {
    const seed = 'x'.repeat(MAX_LANE_SEED_PROMPT_BYTES + 1)
    expect(refusalCode(() => assertLaneSeedPromptWithinBounds(seed))).toBe(
      'terminal.lane_seed_too_long'
    )
  })

  it('counts bytes, not code points, against the budget', () => {
    // A 2-byte character just over half the budget in count is over it in bytes.
    const seed = '€'.repeat(MAX_LANE_SEED_PROMPT_BYTES / 3 + 1)
    expect(refusalCode(() => assertLaneSeedPromptWithinBounds(seed))).toBe(
      'terminal.lane_seed_too_long'
    )
  })

  it('rejects a carriage return (a submit smuggled as a control char)', () => {
    expect(refusalCode(() => assertLaneSeedPromptWithinBounds('go\r'))).toBe(
      'terminal.lane_seed_control_char'
    )
  })

  it('rejects an escape byte', () => {
    expect(refusalCode(() => assertLaneSeedPromptWithinBounds('go\x1b[2J'))).toBe(
      'terminal.lane_seed_control_char'
    )
  })
})

describe('callerMayOpenSourceLane', () => {
  const PTY = 'pty-1'
  const PRINCIPAL_ONE = 'principal-one'
  const PRINCIPAL_TWO = 'principal-two'
  const DESKTOP = 'grant-desktop'
  const PHONE = 'grant-phone'
  const OTHER = 'grant-other'

  const principalOfGrant = (pairedDeviceId: string): string | null => {
    if (pairedDeviceId === DESKTOP || pairedDeviceId === PHONE) {
      return PRINCIPAL_ONE
    }
    if (pairedDeviceId === OTHER) {
      return PRINCIPAL_TWO
    }
    return null
  }

  function registryWith(
    attached: { grant: string; connectionId: string }[],
    registeredOnly: { grant: string; connectionId: string }[] = []
  ): TerminalPresenceRegistry {
    const registry = new TerminalPresenceRegistry()
    for (const { grant, connectionId } of [...attached, ...registeredOnly]) {
      registry.registerConnection({
        connectionId,
        pairedDeviceId: grant,
        label: grant,
        kind: 'runtime'
      })
    }
    for (const { connectionId } of attached) {
      registry.attach(PTY, `sub-${connectionId}`, connectionId)
    }
    return registry
  }

  it('allows a phone whose principal owns a grant ATTACHED to the pane, even though the phone is not attached', () => {
    // MUTATION PROOF (principal→grant): swapping `principalOfGrant(grant) === caller.principalId`
    // for `grant === caller.pairedDeviceId` turns this green case red — the phone's own grant is
    // not among the attached grants, only its desktop is.
    const registry = registryWith([{ grant: DESKTOP, connectionId: 'c-desktop' }])
    expect(
      callerMayOpenSourceLane({
        registry,
        sourcePtyId: PTY,
        caller: { principalId: PRINCIPAL_ONE, pairedDeviceId: PHONE },
        principalOfGrant
      })
    ).toBe(true)
  })

  it('allows grant B (attached) to open on grant A/B principal terminal', () => {
    const registry = registryWith([{ grant: DESKTOP, connectionId: 'c-desktop' }])
    expect(
      callerMayOpenSourceLane({
        registry,
        sourcePtyId: PTY,
        caller: { principalId: PRINCIPAL_ONE, pairedDeviceId: DESKTOP },
        principalOfGrant
      })
    ).toBe(true)
  })

  it('refuses a caller whose principal is only REGISTERED, not attached to the pane', () => {
    // MUTATION PROOF (attachmentsOf→participants): swapping `registry.grantsAttachedTo(ptyId)` for a
    // walk of `registry.connections()` turns this red — the caller's registered-only grant would then
    // count, and a grant that authorizes nothing would authorize this open.
    const registry = registryWith(
      [{ grant: OTHER, connectionId: 'c-other' }],
      [{ grant: DESKTOP, connectionId: 'c-desktop-registered' }]
    )
    expect(
      callerMayOpenSourceLane({
        registry,
        sourcePtyId: PTY,
        caller: { principalId: PRINCIPAL_ONE, pairedDeviceId: DESKTOP },
        principalOfGrant
      })
    ).toBe(false)
  })

  it('refuses when only another principal is attached', () => {
    const registry = registryWith([{ grant: OTHER, connectionId: 'c-other' }])
    expect(
      callerMayOpenSourceLane({
        registry,
        sourcePtyId: PTY,
        caller: { principalId: PRINCIPAL_ONE, pairedDeviceId: DESKTOP },
        principalOfGrant
      })
    ).toBe(false)
  })

  it('refuses when nobody is attached', () => {
    const registry = registryWith([])
    expect(
      callerMayOpenSourceLane({
        registry,
        sourcePtyId: PTY,
        caller: { principalId: PRINCIPAL_ONE, pairedDeviceId: DESKTOP },
        principalOfGrant
      })
    ).toBe(false)
  })

  it('does not count the reserved host attachment as a grant', () => {
    const registry = registryWith([])
    registry.attachHost(PTY)
    expect(registry.grantsAttachedTo(PTY)).toEqual([])
  })
})
