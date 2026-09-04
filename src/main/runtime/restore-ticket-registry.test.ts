import { describe, expect, it } from 'vitest'
import {
  RESTORE_TICKET_TTL_MS,
  RestoreTicketRegistry,
  type RestoreTicketId,
  type RestoreTicketMintArgs
} from './restore-ticket-registry'

function payload(overrides: Partial<RestoreTicketMintArgs> = {}): RestoreTicketMintArgs {
  return {
    predecessorPaneKey: 'tab-1:leaf-1',
    sessionId: 'session-1',
    executionHostId: 'host-1',
    launchGeneration: 'generation-1',
    ...overrides
  }
}

describe('RestoreTicketRegistry (S10-21a C2)', () => {
  it('mints and redeems a ticket exactly once', () => {
    const registry = new RestoreTicketRegistry()
    const id = registry.mint(payload())

    const result = registry.redeem(id)
    expect(result).toEqual({ ok: true, payload: payload() })
  })

  it('refuses a second redeem of the same ticket', () => {
    const registry = new RestoreTicketRegistry()
    const id = registry.mint(payload())

    expect(registry.redeem(id)).toEqual({ ok: true, payload: payload() })
    expect(registry.redeem(id)).toEqual({ ok: false, reason: 'already_redeemed' })
  })

  it('expires a ticket after RESTORE_TICKET_TTL_MS (fake timers)', () => {
    let now = 1_000_000
    const registry = new RestoreTicketRegistry({ now: () => now })
    const id = registry.mint(payload())

    now += RESTORE_TICKET_TTL_MS + 1
    expect(registry.redeem(id)).toEqual({ ok: false, reason: 'expired' })
  })

  it('redeems successfully at exactly the TTL boundary, refuses just past it', () => {
    let now = 0
    const registry = new RestoreTicketRegistry({ now: () => now })
    const idAtBoundary = registry.mint(payload())
    now = RESTORE_TICKET_TTL_MS
    expect(registry.redeem(idAtBoundary)).toEqual({ ok: true, payload: payload() })

    now = 0
    const idPastBoundary = registry.mint(payload())
    now = RESTORE_TICKET_TTL_MS + 1
    expect(registry.redeem(idPastBoundary)).toEqual({ ok: false, reason: 'expired' })
  })

  it('ids are unforgeable: a string of the right shape is not a ticket', () => {
    const registry = new RestoreTicketRegistry()
    registry.mint(payload())

    const forged = '11111111-1111-4111-8111-111111111111' as RestoreTicketId
    expect(registry.redeem(forged)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('peek reads a ticket without consuming it', () => {
    const registry = new RestoreTicketRegistry()
    const id = registry.mint(payload())

    expect(registry.peek(id)).toEqual({ ok: true, payload: payload() })
    // Why: peek must not count as the single use — a subsequent real redeem still succeeds.
    expect(registry.peek(id)).toEqual({ ok: true, payload: payload() })
    expect(registry.redeem(id)).toEqual({ ok: true, payload: payload() })
  })

  it('peek reflects redemption and expiry the same way redeem does', () => {
    let now = 0
    const registry = new RestoreTicketRegistry({ now: () => now })
    const id = registry.mint(payload())
    registry.redeem(id)
    expect(registry.peek(id)).toEqual({ ok: false, reason: 'already_redeemed' })

    const id2 = registry.mint(payload())
    now = RESTORE_TICKET_TTL_MS + 1
    expect(registry.peek(id2)).toEqual({ ok: false, reason: 'expired' })
  })

  it('mint returns distinct ids for distinct tickets, each independently redeemable', () => {
    const registry = new RestoreTicketRegistry()
    const first = registry.mint(payload({ predecessorPaneKey: 'tab-1:leaf-1' }))
    const second = registry.mint(payload({ predecessorPaneKey: 'tab-2:leaf-2' }))

    expect(first).not.toBe(second)
    expect(registry.redeem(first)).toEqual({
      ok: true,
      payload: payload({ predecessorPaneKey: 'tab-1:leaf-1' })
    })
    expect(registry.redeem(second)).toEqual({
      ok: true,
      payload: payload({ predecessorPaneKey: 'tab-2:leaf-2' })
    })
  })
})
