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
  resetSecureFileWindowsUserSidForTests
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

  it('verify-before-Set-Acl: Confirm-AclRestricted is called before the rebuild, Set-Acl only inside the not-restricted branch', async () => {
    await bestEffortRestrictWindowsPath('C:\\Users\\me\\.orca\\secret.json', false)
    const call = execFileMock.mock.calls.find((c) => String(c[0]).endsWith('powershell.exe'))
    const script = decodeEncodedCommand(call![1] as string[])

    const confirmBeforeRebuildIndex = script.indexOf('Confirm-AclRestricted $acl')
    const rebuildIndex = script.indexOf('SetAccessRuleProtection')
    const setAclIndex = script.indexOf('Set-Acl -LiteralPath $path -AclObject $acl')
    const notRestrictedBranchIndex = script.indexOf('if (-not $alreadyRestricted) {')

    expect(confirmBeforeRebuildIndex).toBeGreaterThan(-1)
    expect(confirmBeforeRebuildIndex).toBeLessThan(rebuildIndex)
    expect(setAclIndex).toBeGreaterThan(notRestrictedBranchIndex)
  })
})
