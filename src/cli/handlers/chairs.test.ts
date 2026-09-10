// [D-R170 L3] formatExportResult's own operator-facing behavior (skip clause, quarantine
// clause, older-daemon compatibility) was exercised by no test — the only existing chairs CLI
// test (src/cli/specs/chairs.test.ts) asserts specs/help text, not this file's formatters.
import { describe, expect, it } from 'vitest'
import { formatExportResult, type ChairsManifest, type ExportResult } from './chairs'

function manifest(count: number): ChairsManifest {
  return {
    version: 1,
    chairs: Array.from({ length: count }, (_, i) => ({
      name: `chair-${i}`,
      worktree: 'id:wt-1',
      agent: 'claude',
      conversationId: `sess-${i}`
    }))
  }
}

describe('formatExportResult', () => {
  it('prints just the write line when nothing was skipped or omitted', () => {
    const result: ExportResult = { path: '/tmp/chairs.json', manifest: manifest(2), skipped: [] }
    expect(formatExportResult(result)).toBe('Wrote 2 chair(s) to /tmp/chairs.json')
  })

  it('appends the skip clause with the human-readable reason text', () => {
    const result: ExportResult = {
      path: '/tmp/chairs.json',
      manifest: manifest(1),
      skipped: [
        { name: 'chair-no-pane', reason: 'no_pane' },
        { name: 'chair-no-launch', reason: 'no_launch_row' }
      ]
    }
    expect(formatExportResult(result)).toBe(
      'Wrote 1 chair(s) to /tmp/chairs.json; skipped 2: chair-no-pane (no pane recorded), ' +
        'chair-no-launch (no launch row recorded)'
    )
  })

  // [D-R170 M1] The quarantine-omission clause: chairs filtered out before the skip guards
  // ever run must still be reported, not silently dropped.
  it('appends the omitted-quarantined clause when omittedQuarantined > 0', () => {
    const result: ExportResult = {
      path: '/tmp/chairs.json',
      manifest: manifest(1),
      skipped: [],
      omittedQuarantined: 3
    }
    expect(formatExportResult(result)).toBe(
      'Wrote 1 chair(s) to /tmp/chairs.json; omitted 3 quarantined'
    )
  })

  it('omits the quarantine clause when omittedQuarantined is 0 or absent', () => {
    const zero: ExportResult = {
      path: '/tmp/chairs.json',
      manifest: manifest(1),
      skipped: [],
      omittedQuarantined: 0
    }
    expect(formatExportResult(zero)).toBe('Wrote 1 chair(s) to /tmp/chairs.json')
    const absent: ExportResult = { path: '/tmp/chairs.json', manifest: manifest(1) }
    expect(formatExportResult(absent)).toBe('Wrote 1 chair(s) to /tmp/chairs.json')
  })

  // [D-R170 M4] An older running daemon's response carries neither field at all — the CLI must
  // not throw against it.
  it('does not throw when skipped/omittedQuarantined are absent (older daemon)', () => {
    const result: ExportResult = { path: '/tmp/chairs.json', manifest: manifest(0) }
    expect(() => formatExportResult(result)).not.toThrow()
    expect(formatExportResult(result)).toBe('Wrote 0 chair(s) to /tmp/chairs.json')
  })
})
