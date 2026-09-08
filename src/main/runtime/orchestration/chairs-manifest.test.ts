import { describe, expect, it } from 'vitest'
import { parseChairsManifest } from './chairs-manifest'

function baseEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'backend-dll',
    worktree: 'path:/repo/backend',
    agent: 'claude',
    conversationId: 'sess-abc',
    ...overrides
  }
}

describe('parseChairsManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const result = parseChairsManifest({ version: 1, chairs: [baseEntry()] })
    expect(result.ok).toBe(true)
  })

  it('accepts every optional field, including a valid effort', () => {
    const result = parseChairsManifest({
      version: 1,
      chairs: [
        baseEntry({
          role: 'backend chair',
          lastSessionId: 'sess-def',
          host: 'desktop',
          model: 'opus',
          effort: 'max'
        })
      ]
    })
    expect(result.ok).toBe(true)
  })

  it('refuses the whole file when one entry has an invalid effort, even with a valid entry present', () => {
    const result = parseChairsManifest({
      version: 1,
      chairs: [baseEntry(), baseEntry({ name: 'other', effort: 'nope' })]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('effort')
    }
  })

  it('refuses on missing conversationId', () => {
    const entry = baseEntry()
    delete entry.conversationId
    const result = parseChairsManifest({ version: 1, chairs: [entry] })
    expect(result.ok).toBe(false)
  })

  it('refuses on a non-1 version', () => {
    const result = parseChairsManifest({ version: 2, chairs: [] })
    expect(result.ok).toBe(false)
  })

  it('refuses on a duplicate chair name', () => {
    const result = parseChairsManifest({
      version: 1,
      chairs: [baseEntry(), baseEntry()]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('duplicate')
    }
  })

  it('refuses a non-object root and a non-array chairs field', () => {
    expect(parseChairsManifest(null).ok).toBe(false)
    expect(parseChairsManifest({ version: 1, chairs: 'nope' }).ok).toBe(false)
  })
})
