// P1: Windows PowerShell 5.1 does not bind $args when trailing argv follows -Command, so the
// hardening script previously threw before touching any ACL. Values must be embedded as
// PowerShell literals and launched via -EncodedCommand instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execFile: execFileMock
}))

import {
  bestEffortRestrictWindowsPath,
  restrictWindowsPathSync,
  resetSecureFileWindowsUserSidForTests,
  buildWindowsRestrictAclScriptForTests
} from './secure-path-windows-acl'

const VALID_SID = 'S-1-5-21-1000'

function decodeEncodedCommand(args: string[]): string {
  const index = args.indexOf('-EncodedCommand')
  const encoded = index !== -1 ? args[index + 1] : undefined
  if (!encoded) {
    throw new Error('no -EncodedCommand in argv')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('secure-path-windows-acl P1/F4 (P1 REPAIR)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    process.env.SystemRoot = 'C:\\Windows'
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    resetSecureFileWindowsUserSidForTests()
    execFileSyncMock.mockImplementation((file: string) => {
      if (String(file).endsWith('whoami.exe')) {
        return `"USER","${VALID_SID}"`
      }
      return ''
    })
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, callback: (...a: unknown[]) => void) => {
        callback(null, '', '')
        return {}
      }
    )
  })

  afterEach(() => {
    resetSecureFileWindowsUserSidForTests()
    delete process.env.SystemRoot
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('P1(1): the -EncodedCommand payload decodes to a script with the literal path, sid, flag and no $args', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)

    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    expect(call).toBeDefined()
    const args = call![1] as string[]
    const script = decodeEncodedCommand(args)
    expect(script).toContain("$path = 'C:\\Users\\me\\.orca\\secret.json'")
    expect(script).toContain(`$currentUserSid = '${VALID_SID}'`)
    expect(script).toContain("$isDirectory = '0' -eq '1'")
    expect(script).not.toMatch(/\$args\b/)
  })

  it('P1(2): a path containing a single quote is escaped as two single quotes', async () => {
    const targetPath = "C:\\Users\\o'brien\\.orca\\secret.json"
    await bestEffortRestrictWindowsPath(targetPath, false)

    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])
    expect(script).toContain("$path = 'C:\\Users\\o''brien\\.orca\\secret.json'")
  })

  // G1 repair (item 4): PowerShell's single-quoted-string grammar treats U+2018-U+201B the
  // same as U+0027 as a terminator (about_Quoting_Rules) — only U+0027 was doubled before.
  it('G1 repair: a right single smart quote (U+2019) in the path is escaped and decodes back intact, with no statement boundary introduced', async () => {
    const targetPath = 'C:\\Users\\O\u2019Brien\\.orca\\secret.json'
    await bestEffortRestrictWindowsPath(targetPath, false)

    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])

    // The literal is doubled the same way a plain single quote is doubled.
    expect(script).toContain("$path = 'C:\\Users\\O\u2019\u2019Brien\\.orca\\secret.json'")

    // Decode the single-quoted literal per PowerShell's own escaping rule (a doubled
    // quote-like character is a literal occurrence of that character) and prove the
    // decoded value is exactly the original path — i.e. the statement is not split early.
    const pathLine = script.split('\n').find((line) => line.startsWith('$path = '))
    expect(pathLine).toBeDefined()
    const literalBody = pathLine!.slice("$path = '".length, -1)
    const decoded = literalBody.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1')
    expect(decoded).toBe(targetPath)

    // The next statement is still $currentUserSid, unaffected by the embedded quote.
    const currentUserSidIndex = script.indexOf('$currentUserSid = ')
    expect(currentUserSidIndex).toBeGreaterThan(script.indexOf('$path = '))
  })

  it('P1(3): an invalid SID is refused before any spawn (async)', async () => {
    execFileSyncMock.mockImplementation((file: string) => {
      if (String(file).endsWith('whoami.exe')) {
        return '"USER","not-a-sid"'
      }
      return ''
    })

    const result = await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)

    expect(result).toBe(false)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('P1(3): an invalid SID is refused before any spawn (sync)', () => {
    execFileSyncMock.mockImplementation((file: string) => {
      if (String(file).endsWith('whoami.exe')) {
        return '"USER","not-a-sid"'
      }
      return ''
    })

    const result = restrictWindowsPathSync('C:\\Users\\me\\.orca\\secret.json', false)

    expect(result).toBe(false)
    // Only whoami.exe may have been invoked via execFileSync — never powershell.exe.
    for (const call of execFileSyncMock.mock.calls) {
      expect(String(call[0])).not.toContain('powershell.exe')
    }
  })

  it('P1(4): execFile argv is exactly the flag set with -EncodedCommand and no trailing args', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)

    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const args = call![1] as string[]
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      expect.any(String)
    ])
  })

  it('F4: the pre-check requires the current user SID with FullControl', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])
    expect(script).toContain('Missing required FullControl ACE for current user')
    expect(script).toMatch(/foundCurrentUserFullControl/)
  })

  it('F4: for directories the pre-check requires CI|OI without InheritOnly', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca', true)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])
    expect(script).toContain('requiredInheritance')
    expect(script).toContain('PropagationFlags]::InheritOnly')
  })

  // G1 repair (item 6, F4 coverage): the two tests above only check substring presence, which
  // survives neutralising the throw-guard or flipping the comparison operator (8/8 green per
  // the review). Assert the exact guard/operator text and prove the check is red-provable.
  describe('F4 (red-provable mutations)', () => {
    async function getDecodedScript(isDirectory = false): Promise<string> {
      await bestEffortRestrictWindowsPath(
        isDirectory ? 'C:\\Users\\me\\.orca' : 'C:\\Users\\me\\.orca\\secret.json',
        isDirectory
      )
      const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
      return decodeEncodedCommand(call![1] as string[])
    }

    const FULL_CONTROL_GUARD =
      "if (-not $foundCurrentUserFullControl) {\n    throw 'Missing required FullControl ACE for current user'\n  }"
    const NOT_INHERIT_ONLY =
      '$notInheritOnly = $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::InheritOnly'

    function verifyF4Invariants(script: string): {
      fullControlNeutralized: boolean
      inheritOnlyInverted: boolean
    } {
      return {
        fullControlNeutralized: !script.includes(FULL_CONTROL_GUARD),
        inheritOnlyInverted: !script.includes(NOT_INHERIT_ONLY)
      }
    }

    it('the real script keeps both F4 guards intact', async () => {
      const script = await getDecodedScript()
      const violations = verifyF4Invariants(script)
      expect(violations.fullControlNeutralized).toBe(false)
      expect(violations.inheritOnlyInverted).toBe(false)
    })

    it('mutation: neutralising the FullControl requirement (deleting the throw-guard) is caught', async () => {
      const script = await getDecodedScript()
      expect(script).toContain(FULL_CONTROL_GUARD)
      const mutated = script.replace(FULL_CONTROL_GUARD, '')

      expect(verifyF4Invariants(mutated).fullControlNeutralized).toBe(true)
    })

    it('mutation: inverting the InheritOnly check (-ne to -eq) is caught', async () => {
      const script = await getDecodedScript(true)
      expect(script).toContain(NOT_INHERIT_ONLY)
      const mutated = script.replace(
        NOT_INHERIT_ONLY,
        '$notInheritOnly = $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::InheritOnly'
      )

      expect(verifyF4Invariants(mutated).inheritOnlyInverted).toBe(true)
    })
  })

  // G1 repair (item 5): verify-first is a FILE-only optimization. A directory's first
  // propagation can be interrupted by the spawn timeout; once its root already verifies, no
  // later run re-propagates to the rest of the tree, so directories must always rebuild.
  it('G1 repair: the rebuild branch runs unconditionally for directories, not gated on $alreadyRestricted alone', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca', true)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])
    expect(script).toContain('if ($isDirectory -or -not $alreadyRestricted) {')
  })

  it('G1 repair: a directory run gets a longer execFile timeout than a file run', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)
    const fileCall = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const fileTimeout = (fileCall![2] as { timeout: number }).timeout

    execFileMock.mockClear()
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca', true)
    const dirCall = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const dirTimeout = (dirCall![2] as { timeout: number }).timeout

    expect(dirTimeout).toBeGreaterThan(fileTimeout)
    expect(dirTimeout).toBeGreaterThanOrEqual(20_000)
  })

  it('verify-before-Set-Acl: Confirm-AclRestricted is called before the rebuild, Set-Acl only inside the not-restricted branch', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])

    const confirmBeforeRebuildIndex = script.indexOf('Confirm-AclRestricted $acl')
    const rebuildIndex = script.indexOf('SetAccessRuleProtection')
    const setAclIndex = script.indexOf('Set-Acl -LiteralPath $path -AclObject $acl')
    const notRestrictedBranchIndex = script.indexOf(
      'if ($isDirectory -or -not $alreadyRestricted) {'
    )

    expect(confirmBeforeRebuildIndex).toBeGreaterThan(-1)
    expect(confirmBeforeRebuildIndex).toBeLessThan(rebuildIndex)
    expect(setAclIndex).toBeGreaterThan(notRestrictedBranchIndex)
  })

  // G1 repair (blocking 3): the string-position check above only proves the FIRST Set-Acl
  // sits after the branch marker, not that it (or any $alreadyRestricted = $false) is actually
  // CONTAINED by the branch/catch it must live in. Brace-match both blocks and assert
  // containment, then prove the check is red by mutating the decoded script text the two ways
  // the review demonstrated: Set-Acl moved after the branch, and the pre-check result discarded.
  describe('verify-before-Set-Acl (red-provable, G1 blocking 3)', () => {
    /** Returns the [openBrace, matchingCloseBrace] index pair for the block starting at openBraceIndex. */
    function matchingBraceBlock(
      script: string,
      openBraceIndex: number
    ): { start: number; end: number } {
      let depth = 0
      for (let i = openBraceIndex; i < script.length; i++) {
        if (script[i] === '{') {
          depth += 1
        } else if (script[i] === '}') {
          depth -= 1
          if (depth === 0) {
            return { start: openBraceIndex, end: i }
          }
        }
      }
      throw new Error(`unbalanced braces from ${openBraceIndex}`)
    }

    function allIndicesOf(haystack: string, needle: string): number[] {
      const indices: number[] = []
      let from = 0
      for (;;) {
        const idx = haystack.indexOf(needle, from)
        if (idx === -1) {
          return indices
        }
        indices.push(idx)
        from = idx + 1
      }
    }

    /** True if the script has a Set-Acl call, or an $alreadyRestricted = $false assignment,
     *  outside the block it is required to live in. */
    function verifyBeforeSetAclViolations(script: string): {
      setAclOutsideBranch: boolean
      alreadyRestrictedFalseOutsideCatch: boolean
    } {
      const ifIndex = script.indexOf('if ($isDirectory -or -not $alreadyRestricted) {')
      if (ifIndex === -1) {
        throw new Error('missing the not-restricted branch')
      }
      const branch = matchingBraceBlock(script, script.indexOf('{', ifIndex))
      const setAclOutsideBranch = allIndicesOf(
        script,
        'Set-Acl -LiteralPath $path -AclObject $acl'
      ).some((idx) => idx < branch.start || idx > branch.end)

      const tryIndex = script.indexOf('try {')
      if (tryIndex === -1) {
        throw new Error('missing the pre-check try block')
      }
      const tryBlock = matchingBraceBlock(script, script.indexOf('{', tryIndex))
      const catchBraceIndex = script.indexOf('{', tryBlock.end + 1)
      const catchBlock = matchingBraceBlock(script, catchBraceIndex)
      const alreadyRestrictedFalseOutsideCatch = allIndicesOf(
        script,
        '$alreadyRestricted = $false'
      ).some((idx) => idx < catchBlock.start || idx > catchBlock.end)

      return { setAclOutsideBranch, alreadyRestrictedFalseOutsideCatch }
    }

    async function getDecodedScript(): Promise<string> {
      await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)
      const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
      return decodeEncodedCommand(call![1] as string[])
    }

    it('the real script: Set-Acl lives only inside the branch, $alreadyRestricted = $false only inside the catch', async () => {
      const script = await getDecodedScript()
      const violations = verifyBeforeSetAclViolations(script)
      expect(violations.setAclOutsideBranch).toBe(false)
      expect(violations.alreadyRestrictedFalseOutsideCatch).toBe(false)
    })

    it('mutation M-a1: Set-Acl moved after the not-restricted branch is caught', async () => {
      const script = await getDecodedScript()
      const setAclLine = 'Set-Acl -LiteralPath $path -AclObject $acl\n'
      expect(script).toContain(setAclLine)
      const withoutSetAcl = script.replace(setAclLine, '')
      const ifIndex = withoutSetAcl.indexOf('if ($isDirectory -or -not $alreadyRestricted) {')
      const branch = matchingBraceBlock(withoutSetAcl, withoutSetAcl.indexOf('{', ifIndex))
      // Re-insert Set-Acl one character past the branch's closing brace — outside it.
      const mutated = `${withoutSetAcl.slice(0, branch.end + 1)}\n${setAclLine}${withoutSetAcl.slice(branch.end + 1)}`

      expect(verifyBeforeSetAclViolations(mutated).setAclOutsideBranch).toBe(true)
    })

    it('mutation M-a2: discarding the pre-check result is caught', async () => {
      const script = await getDecodedScript()
      const marker = 'if ($isDirectory -or -not $alreadyRestricted) {'
      expect(script).toContain(marker)
      // The exact bug item C step 1 removes: force $alreadyRestricted = $false unconditionally,
      // right before the branch that is supposed to gate on the pre-check's real result.
      const mutated = script.replace(marker, `$alreadyRestricted = $false\n${marker}`)

      expect(verifyBeforeSetAclViolations(mutated).alreadyRestrictedFalseOutsideCatch).toBe(true)
    })
  })

  // G1 attempt-4 blocking 2(a): the syntax/decision-table/acl/secure-file tests all decode the
  // TEST-ONLY builder's own output (buildWindowsRestrictAclScriptForTests), never the payload
  // either launcher actually encodes (:55-63 above) — a launcher-only mutation (e.g. appending
  // unparseable text, or neutralising the pre-check only in the encoded copy) survives all four
  // files untouched. Pin the two payloads to the same builder output directly.
  describe('launcher payload equals the test-only builder (G1 attempt-4 blocking 2a)', () => {
    it.each([
      ['file', false],
      ['directory', true]
    ] as const)(
      'async launcher payload for a %s equals buildWindowsRestrictAclScriptForTests',
      async (_label, isDirectory) => {
        const targetPath = isDirectory
          ? 'C:\\Users\\me\\.orca'
          : 'C:\\Users\\me\\.orca\\secret.json'
        await bestEffortRestrictWindowsPath(targetPath, isDirectory)
        const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
        expect(call).toBeDefined()
        const shipped = decodeEncodedCommand(call![1] as string[])
        const expected = buildWindowsRestrictAclScriptForTests(targetPath, VALID_SID, isDirectory)
        expect(shipped).toBe(expected)
      }
    )

    it.each([
      ['file', false],
      ['directory', true]
    ] as const)(
      'sync launcher payload for a %s equals buildWindowsRestrictAclScriptForTests',
      (_label, isDirectory) => {
        const targetPath = isDirectory
          ? 'C:\\Users\\me\\.orca'
          : 'C:\\Users\\me\\.orca\\secret.json'
        restrictWindowsPathSync(targetPath, isDirectory)
        const call = execFileSyncMock.mock.calls.find((c) =>
          String(c[0]).endsWith('powershell.exe')
        )
        expect(call).toBeDefined()
        const shipped = decodeEncodedCommand(call![1] as string[])
        const expected = buildWindowsRestrictAclScriptForTests(targetPath, VALID_SID, isDirectory)
        expect(shipped).toBe(expected)
      }
    )
  })
})
