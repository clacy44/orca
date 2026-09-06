// S10-21b B12b (TESTS item 4): the bundled orchestration skill guide's "pacts are host-local"
// text (H7 A2) no longer applies to `pact --with`, and the operator page names the six
// constants (§7) with their correct values.
import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from './bundled-skill-guides'

function orchestrationGuideText(): string {
  const guide = BUNDLED_SKILL_GUIDES.find((g) => g.name === 'orchestration')
  if (!guide) {
    throw new Error('orchestration skill guide missing from BUNDLED_SKILL_GUIDES')
  }
  return guide.markdown
}

describe('bundled orchestration skill guide (S10-21b B12b)', () => {
  it('no longer claims pact --with is host-local', () => {
    const text = orchestrationGuideText()
    expect(text).not.toContain('Pacts are host-local')
    expect(text).not.toMatch(/`pact --with`\/`invite --agent` are host-local/)
  })

  it('documents the six named constants with their correct values', () => {
    const text = orchestrationGuideText()
    expect(text).toContain('PACT_MAX_GAP = 64')
    expect(text).toContain('PACT_RELAY_HOLD_MAX_MS = 86_400_000')
    expect(text).toContain('PACT_LINK_SILENCE_MS = 900_000')
    expect(text).toContain('PACT_PROPOSAL_BLOCK_MS = 3_600_000')
    expect(text).toContain('PACT_RELEASED_RETENTION_MS = 604_800_000')
    expect(text).toContain('PACT_STEPS_PER_LINK_CEILING = 65_536')
  })

  it('still documents the federated CLI surface', () => {
    const text = orchestrationGuideText()
    expect(text).toContain('orca agents pact --with <name>[@<host>] --on <thread>')
    expect(text).toContain('orca agents pact --purge-peer-ledger --link <id> [--force-released]')
    expect(text).toContain('--evidence "<text>"')
  })
})
