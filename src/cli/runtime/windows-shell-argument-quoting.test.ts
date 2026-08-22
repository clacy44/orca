import { describe, expect, it } from 'vitest'
import { RuntimeClientError } from './types'
import { quoteWindowsShellArgument } from './windows-shell-argument-quoting'

describe('quoteWindowsShellArgument', () => {
  it('leaves a token that needs no quoting byte-identical', () => {
    // Negative control: the flags themselves must reach the child exactly as before.
    expect(quoteWindowsShellArgument('--serve')).toBe('--serve')
    expect(quoteWindowsShellArgument('100.64.1.20')).toBe('100.64.1.20')
    expect(quoteWindowsShellArgument('Ana')).toBe('Ana')
  })

  it('quotes spaces and cmd metacharacters so one value stays one argument', () => {
    expect(quoteWindowsShellArgument('Ana Smith')).toBe('"Ana Smith"')
    expect(quoteWindowsShellArgument('a & whoami')).toBe('"a & whoami"')
    expect(quoteWindowsShellArgument('a|b')).toBe('"a|b"')
    expect(quoteWindowsShellArgument('')).toBe('""')
  })

  it('doubles a trailing backslash run so it cannot escape the closing quote', () => {
    expect(quoteWindowsShellArgument('C:\\Program Files\\')).toBe('"C:\\Program Files\\\\"')
  })

  it('refuses what cmd offers no escape for', () => {
    // cmd expands %VAR% inside quotes as well, and a literal quote would end the quoted run.
    for (const argument of ['%USERNAME%', 'Ana"Smith', 'Ana\r', 'Ana\nBen']) {
      expect(() => quoteWindowsShellArgument(argument)).toThrow(RuntimeClientError)
    }
  })
})
