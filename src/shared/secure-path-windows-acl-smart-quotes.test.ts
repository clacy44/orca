// G1 round-3 non-blocking 7: only U+2019 (right single quote) was covered by a test; the escape
// regex (secure-path-windows-acl.ts:40) also covers U+2018 (left single quote), U+201A (single
// low-9 quote) and U+201B (single high-reversed-9 quote) per about_Quoting_Rules, but nothing
// proved it. M-sq2 (G1 attempt-3 blocking) drops those three from the regex and survived 17/17.
import { describe, expect, it } from 'vitest'
import { buildWindowsRestrictAclScriptForTests } from './secure-path-windows-acl'

const VALID_SID = 'S-1-5-21-1000'

function pathLineLiteralBody(script: string): string {
  const pathLine = script.split('\n').find((line) => line.startsWith('$path = '))
  if (!pathLine) {
    throw new Error('no $path line in script')
  }
  return pathLine.slice("$path = '".length, -1)
}

describe('secure-path-windows-acl smart-quote escaping (G1 round-3 non-blocking 7)', () => {
  it.each([
    ['U+2018 (left single quote)', '\u2018'],
    ['U+201A (single low-9 quote)', '\u201a'],
    ['U+201B (single high-reversed-9 quote)', '\u201b']
  ])('%s is doubled and round-trips intact', (_label, quoteChar) => {
    const targetPath = `C:\\Users\\a${quoteChar}b\\.orca\\secret.json`
    const script = buildWindowsRestrictAclScriptForTests(targetPath, VALID_SID, false)
    const literalBody = pathLineLiteralBody(script)

    expect(literalBody).toContain(`${quoteChar}${quoteChar}`)

    const decoded = literalBody.replace(/(['\u2018\u2019\u201a\u201b])\1/g, '$1')
    expect(decoded).toBe(targetPath)
  })

  it('mutation M-sq2 (only U+2019 doubled) is caught: U+2018/U+201A/U+201B stay unescaped', () => {
    const mutatedRegex = /['\u2019]/g
    for (const quoteChar of ['\u2018', '\u201a', '\u201b']) {
      const targetPath = `C:\\Users\\a${quoteChar}b\\.orca\\secret.json`
      const realScript = buildWindowsRestrictAclScriptForTests(targetPath, VALID_SID, false)
      const realLiteralBody = pathLineLiteralBody(realScript)
      const mutatedLiteralBody = targetPath.replace(mutatedRegex, '$&$&')

      // The real escaper doubles this quote-like character; M-sq2's narrower regex does not —
      // so a test that only checked U+2019 would have missed this survivor.
      expect(realLiteralBody).not.toBe(mutatedLiteralBody)
      expect(mutatedLiteralBody).not.toContain(`${quoteChar}${quoteChar}`)
    }
  })
})
