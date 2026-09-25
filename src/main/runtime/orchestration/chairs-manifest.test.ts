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

  it('accepts succession and launchArgs, and a manifest carrying both survives parse -> JSON.stringify unchanged', () => {
    const raw = {
      version: 1,
      chairs: [
        baseEntry({
          succession: { enabled: true, charterPath: '/repo/CHARTER.md', charterMode: 'embed' },
          launchArgs: ['--autocompact', '200000']
        })
      ]
    }
    const result = parseChairsManifest(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(JSON.stringify(result.manifest)).toBe(JSON.stringify(raw))
    }
  })

  it('refuses succession.enabled non-boolean, succession.charterPath missing, and a launchArgs element with a newline', () => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ succession: { enabled: 'yes', charterPath: '/x' } })]
      }).ok
    ).toBe(false)
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ succession: { enabled: true } })]
      }).ok
    ).toBe(false)
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['ok', 'bad\narg'] })]
      }).ok
    ).toBe(false)
  })

  // [G1-10z L2 repair] launchArgs is typed into an interactive shell — \n/\r alone left every
  // other C0 control, DEL and every C1 control unrefused.
  it('refuses launchArgs elements carrying C0 (non-tab), DEL, or C1 control characters', () => {
    const controlChars = ['\x00', '\x03', '\x1b', '\x7f', '\x80', '\x9f']
    for (const ch of controlChars) {
      expect(
        parseChairsManifest({
          version: 1,
          chairs: [baseEntry({ launchArgs: ['ok', `bad${ch}arg`] })]
        }).ok,
        `expected refusal for control char 0x${ch.charCodeAt(0).toString(16)}`
      ).toBe(false)
    }
  })

  it('accepts a launchArgs element containing a tab (a legitimate argv-element separator)', () => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['ok', 'has\ttab'] })]
      }).ok
    ).toBe(true)
  })
})
