// S10-21a C7i (Ruling 34 Addendum 27). New module — every test fails at base (033bc1f4d9): the
// module does not exist, so the import itself throws.
import { describe, expect, it } from 'vitest'
import {
  agentAlive,
  classifyUnparseableProcessIncarnation,
  parseProcessIncarnation,
  type ControllerInventory
} from './agent-process-identity'

describe('parseProcessIncarnation', () => {
  // [S10-21c B-final F1, D-R159 finding 1, SCENARIO_CORRECTION] Was 'pty-1:inc-1' — a
  // non-UUID incarnation id that no real writer has ever minted (every one uses
  // `randomUUID()`) and that the new explicit shape check now correctly rejects, exactly as it
  // must reject the legacy 3-segment form below by the same rule. Corrected to a UUID-shaped
  // incarnation id so this fixture still tests the 2-segment happy path it always meant to.
  it('parses a 2-segment "<ptyId>:<incarnationId>" form', () => {
    expect(parseProcessIncarnation('pty-1:11aa1e44-9e8f-4ea0-b1c6-7604ce8bf246')).toEqual({
      ptyId: 'pty-1',
      incarnationId: '11aa1e44-9e8f-4ea0-b1c6-7604ce8bf246'
    })
  })

  // [S10-21c B-final F1, D-R159 finding 1] The real shape `getTerminalProcessIncarnation`
  // produces for a worktree pty: `${repoId}::${path}@@${short}:${uuid}` — measured on-box,
  // agent_audit/agents.process_incarnation both carry this exact shape. Splitting at the FIRST
  // ':' (the pre-fix behaviour) tore `ptyId` in half and rejected it; splitting at the LAST ':'
  // with the incarnation id checked as a UUID parses it correctly.
  it('parses the real worktree-pty shape "<repoId>::<path>@@<short>:<uuid>" (fails at base: base rejects every colon-containing ptyId)', () => {
    expect(
      parseProcessIncarnation(
        '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@Zb7_DmyB:11aa1e44-9e8f-4ea0-b1c6-7604ce8bf246'
      )
    ).toEqual({
      ptyId: '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@Zb7_DmyB',
      incarnationId: '11aa1e44-9e8f-4ea0-b1c6-7604ce8bf246'
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

// [S10-21c B-final L6, D-R160 low 6]
describe('classifyUnparseableProcessIncarnation', () => {
  it("the legacy 3-segment '<runtimeId>:<ptyId>:<gen>' shape -> 'legacy_form'", () => {
    expect(classifyUnparseableProcessIncarnation('runtime-1:pty-1:gen-1')).toBe('legacy_form')
  })

  it("a 2-segment ptyId:incarnation pair whose incarnation just isn't a UUID -> 'non_uuid_incarnation'", () => {
    expect(classifyUnparseableProcessIncarnation('pty-1:not-a-uuid')).toBe('non_uuid_incarnation')
  })

  it("a real worktree ptyId (its own '::' colons) with a non-UUID incarnation -> 'non_uuid_incarnation', never 'legacy_form'", () => {
    expect(
      classifyUnparseableProcessIncarnation(
        '214dd5c0-7235-4fed-99c9-9d9480fca577::/home/ubuntu@@Zb7_DmyB:not-a-uuid'
      )
    ).toBe('non_uuid_incarnation')
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
