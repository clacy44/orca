// S10-21a C7i (Ruling 34 Addendum 27). New module — every test fails at base (033bc1f4d9): the
// module does not exist, so the import itself throws.
import { describe, expect, it } from 'vitest'
import {
  agentAlive,
  parseProcessIncarnation,
  type ControllerInventory
} from './agent-process-identity'

describe('parseProcessIncarnation', () => {
  it('parses a 2-segment "<ptyId>:<incarnationId>" form', () => {
    expect(parseProcessIncarnation('pty-1:inc-1')).toEqual({
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    })
  })

  it('rejects a 3-segment legacy "<runtimeId>:<ptyId>:<gen>" form as not an identity', () => {
    expect(parseProcessIncarnation('runtime-1:pty-1:gen-1')).toBeNull()
  })

  it('rejects empty/null/undefined', () => {
    expect(parseProcessIncarnation('')).toBeNull()
    expect(parseProcessIncarnation(null)).toBeNull()
    expect(parseProcessIncarnation(undefined)).toBeNull()
  })
})

describe('agentAlive', () => {
  const IDENTITY = { ptyId: 'pty-1', incarnationId: 'inc-1' }

  function inventory(overrides: Partial<ControllerInventory> = {}): ControllerInventory {
    return {
      allLivePtyIds: new Set(),
      terminalIdentityByPtyId: new Map(),
      ...overrides
    }
  }

  it('unknown_no_identity when there is no parsed identity', () => {
    expect(agentAlive(null, inventory())).toBe('unknown_no_identity')
  })

  it('unknown_inventory when the round is null', () => {
    expect(agentAlive(IDENTITY, null)).toBe('unknown_inventory')
  })

  it('alive when the identity map lists the ptyId with the SAME incarnationId', () => {
    const inv = inventory({
      allLivePtyIds: new Set(['pty-1']),
      terminalIdentityByPtyId: new Map([['pty-1', { handle: 'term_1', incarnationId: 'inc-1' }]])
    })
    expect(agentAlive(IDENTITY, inv)).toBe('alive')
  })

  it('unknown_ambiguous_pty when allLivePtyIds has the ptyId but the identity map does not', () => {
    const inv = inventory({ allLivePtyIds: new Set(['pty-1']) })
    expect(agentAlive(IDENTITY, inv)).toBe('unknown_ambiguous_pty')
  })

  it('dead when the ptyId is listed with a DIFFERENT incarnation (same id, other incarnation is not the agent)', () => {
    const inv = inventory({
      allLivePtyIds: new Set(['pty-1']),
      terminalIdentityByPtyId: new Map([
        ['pty-1', { handle: 'term_1', incarnationId: 'inc-OTHER' }]
      ])
    })
    expect(agentAlive(IDENTITY, inv)).toBe('dead')
  })

  it('dead when the ptyId is absent from the round entirely', () => {
    expect(agentAlive(IDENTITY, inventory())).toBe('dead')
  })
})
