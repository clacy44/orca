// INV-P-023: positive control for the parser against real whoami output. Windows CI lane only
// (.github/workflows/pr.yml "Test Windows-specific boundaries"). GitHub's Windows runners are
// assumed elevated [I] — accept either medium or high.
import { describe, expect, it } from 'vitest'
import { probeCurrentProcessIntegrity } from './windows-integrity-level'

describe.runIf(process.platform === 'win32')('probeCurrentProcessIntegrity (real whoami)', () => {
  it('returns medium or high, with a detail matching S-1-16-<rid>', async () => {
    const result = await probeCurrentProcessIntegrity()
    expect(['medium', 'high']).toContain(result.level)
    expect(result.detail).toMatch(/^S-1-16-\d+$/)
  })
})
