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

  // [G1-10z attempt-2 N11 repair] a manifest-supplied resume/session/fork selector in launchArgs
  // bypasses spawn-time admission's --session-id/--fork-session refusal, which only inspects the
  // tokens it constructs itself — never a manifest's launchArgs.
  it.each([
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--session-id',
    '--fork-session',
    '--resume=sess-123',
    '--session-id=sess-123',
    '--fork-session=sess-123'
  ])('refuses a launchArgs element that is the resume/session/fork selector "%s"', (selector) => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['ok', selector] })]
      }).ok
    ).toBe(false)
  })

  it('accepts a launchArgs element that merely contains "resume" as a substring, not the selector itself', () => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['--autoresume', 'resume-note'] })]
      }).ok
    ).toBe(true)
  })

  // G1 attempt-3 repair F7 (probe p9): the old check matched each ELEMENT exactly, but the launch
  // joins every element with ' ' and re-tokenizes on whitespace before building the command — a
  // joined short form, or a selector riding along inside one element via leading/embedded/tab
  // whitespace, reached the built command unrefused. Validate the same way the launch tokenizes.
  it.each([
    ['joined short form -r<id>', ['-rdeadbeef-0000-4000-8000-000000000000']],
    ['leading space before --continue', [' --continue']],
    ['embedded space before --continue', ['--verbose --continue']],
    ['leading tab before -c', ['\t-c']]
  ])('refuses launchArgs %s', (_label, launchArgs) => {
    expect(parseChairsManifest({ version: 1, chairs: [baseEntry({ launchArgs })] }).ok).toBe(false)
  })

  // G1-10z attempt-4 H3 (probe p9): the F7 validator split on `/\s+/` instead of using the
  // launch's own POSIX tokenizer, so quoted/escaped selectors were never re-split away from
  // their quotes and passed the exact-token check unrefused.
  it.each([
    ['double-quoted --continue', ['"--continue"']],
    ['single-quoted -c', ["'-c'"]],
    ['empty quotes inside --continue', ['--con""tinue']],
    ['backslash-escaped -c', ['\\-c']],
    ['quoted -r then an id', ['"-r"', 'deadbeef-0000-4000-8000-000000000000']],
    ['quoted --resume=<id>', ['"--resume=deadbeef-0000-4000-8000-000000000000"']]
  ])('H3: refuses launchArgs bypassing the naive split via %s', (_label, launchArgs) => {
    expect(parseChairsManifest({ version: 1, chairs: [baseEntry({ launchArgs })] }).ok).toBe(false)
  })

  // G1-10z attempt-4 H3 (probe p9): the false-positive side — a naive `/\s+/` split treated a
  // legitimate quoted phrase merely CONTAINING "-c" as if "-c" were its own token, refusing the
  // whole manifest file. The real tokenizer keeps the quoted phrase as one token.
  it('H3: accepts a quoted multi-word value that merely contains "-c" as text, not a token', () => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['"Be careful: -c resumes"'] })]
      }).ok
    ).toBe(true)
  })

  // N4 (G1-10z polish-recheck, probe P4w): the validator hardcoded the POSIX tokenizer, but the
  // launch itself may tokenize with a Windows shell — a PowerShell backtick or cmd caret escape
  // of a selector is not selector-shaped under POSIX word-splitting, so it passed unrefused.
  it.each([
    ['powershell backtick-escaped -c', ['`-c']],
    ['cmd caret-escaped -c', ['^-c']]
  ])('N4: refuses a Windows-shell-escaped selector, %s', (_label, launchArgs) => {
    const result = parseChairsManifest({ version: 1, chairs: [baseEntry({ launchArgs })] })
    expect(result.ok).toBe(false)
  })

  // N4: the quoted multi-word false-positive fix must hold under every checked shell, not just
  // POSIX — a double-quoted phrase merely containing "-c" is one token under cmd/powershell too.
  it('N4: still accepts the quoted multi-word "-c" text value under every checked shell', () => {
    expect(
      parseChairsManifest({
        version: 1,
        chairs: [baseEntry({ launchArgs: ['"Be careful: -c resumes"'] })]
      }).ok
    ).toBe(true)
  })
})
