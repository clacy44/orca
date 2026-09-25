// G1 round-3 item 3: lands the reviewer's decision-table harness (G1 attempt 3) as a pwsh-gated
// vitest test. Shadows Get-Acl/Set-Acl and the two Windows-only constructors with PowerShell
// classes so the REAL emitted script's branch logic runs under Linux pwsh, then walks the 8-case
// FILE decision table, the directory case and the no-op Set-Acl case. Also proves the harness
// kills mutants M-a4, M-a5, M-a6, M-a8, M-a9, M-a10, M-a11 (G1 blocking 2).
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildWindowsRestrictAclScriptForTests } from './secure-path-windows-acl'

const VALID_SID = 'S-1-5-21-1000'
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const pwshSkipNote = pwshAvailable ? '' : ' [SKIPPED: pwsh not found on PATH]'

const FC = '[System.Security.AccessControl.FileSystemRights]::FullControl'
const RX = '[System.Security.AccessControl.FileSystemRights]::ReadAndExecute'
const NONE_INH = '[System.Security.AccessControl.InheritanceFlags]::None'
const CIOI =
  '([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)'
const PNONE = '[System.Security.AccessControl.PropagationFlags]::None'
const ALLOW = '[System.Security.AccessControl.AccessControlType]::Allow'
const DENY = '[System.Security.AccessControl.AccessControlType]::Deny'

function spec(sid: string, rights = FC, inh = NONE_INH, prop = PNONE, typ = ALLOW): string {
  return `@('${sid}', ${rights}, ${inh}, ${prop}, ${typ})`
}
function ownerOnly(inh = NONE_INH): string[] {
  return [spec(VALID_SID, FC, inh), spec('S-1-5-18', FC, inh), spec('S-1-5-32-544', FC, inh)]
}

// Shadows Get-Acl/Set-Acl and the two Windows-only constructors so the real emitted script can
// run its actual branch logic under Linux pwsh (source: reviewer's probe-files/mock-prefix.ps1).
const MOCK_PREFIX = `
class MockSid { [string]$Value; MockSid([string]$v) { $this.Value = $v } }
class MockIdRef { [string]$Sid; MockIdRef([string]$s) { $this.Sid = $s }
  [object] Translate([type]$t) { return [pscustomobject]@{ Value = $this.Sid } } }
class MockRule { [object]$IdentityReference; [object]$FileSystemRights; [object]$InheritanceFlags; [object]$PropagationFlags; [object]$AccessControlType
  MockRule([object]$sid, [object]$rights, [object]$inh, [object]$prop, [object]$type) {
    $sidText = if ($sid -is [string]) { $sid } else { $sid.Value }
    $this.IdentityReference = [MockIdRef]::new($sidText); $this.FileSystemRights = $rights
    $this.InheritanceFlags = $inh; $this.PropagationFlags = $prop; $this.AccessControlType = $type } }
class MockAcl { [bool]$AreAccessRulesProtected; [System.Collections.ArrayList]$Access = [System.Collections.ArrayList]::new()
  [void] SetAccessRuleProtection([bool]$p, [bool]$keep) { $this.AreAccessRulesProtected = $p }
  [bool] RemoveAccessRuleSpecific([object]$r) { $this.Access.Remove($r); return $true }
  [void] AddAccessRule([object]$r) { [void]$this.Access.Add($r) } }
function New-CaseAcl([bool]$protectedFlag, [object[]]$specs) {
  $a = [MockAcl]::new(); $a.AreAccessRulesProtected = $protectedFlag
  foreach ($s in $specs) { [void]$a.Access.Add([MockRule]::new($s[0], $s[1], $s[2], $s[3], $s[4])) }
  return $a }
$global:SetAclCalls = 0
$global:StoredAcl = $null
function Get-Acl { param([string]$LiteralPath)
  if ($null -ne $global:StoredAcl) { $x = [MockAcl]::new(); $x.AreAccessRulesProtected = $global:StoredAcl.AreAccessRulesProtected
    foreach ($r in $global:StoredAcl.Access) { [void]$x.Access.Add($r) }; return $x }
  return (New-CaseAcl $global:CaseProtected $global:CaseSpecs) }
function Set-Acl { param([string]$LiteralPath, [object]$AclObject)
  $global:SetAclCalls++
  if (-not $global:SetAclIsNoOp) { $global:StoredAcl = $AclObject } }
`

function mockify(script: string): string {
  return script
    .replace(
      '[System.Security.Principal.SecurityIdentifier]::new($sidText)',
      '[MockSid]::new($sidText)'
    )
    .replace('[System.Security.AccessControl.FileSystemAccessRule]::new(', '[MockRule]::new(')
}

function caseSetup(protectedFlag: boolean, specs: string[], noop = false): string {
  return [
    `$global:CaseProtected = $${protectedFlag ? 'true' : 'false'}`,
    `$global:CaseSpecs = @(${specs.join(', ')})`,
    `$global:SetAclIsNoOp = $${noop ? 'true' : 'false'}`,
    '$global:StoredAcl = $null'
  ].join('\n')
}

function runCase(
  script: string,
  protectedFlag: boolean,
  specs: string[],
  noop = false
): { exitCode: number; setAclCalls: number | null; final: string | null } {
  const tail = `
[Console]::Out.WriteLine('SETACL=' + $global:SetAclCalls + ' FINAL=' + (($global:StoredAcl.Access | ForEach-Object { $_.IdentityReference.Sid }) -join ','))
`
  const text = `${MOCK_PREFIX}${caseSetup(protectedFlag, specs, noop)}\n${mockify(script)}${tail}`
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', text], {
    encoding: 'utf-8'
  })
  const line = result.stdout.split('\n').find((l) => l.startsWith('SETACL='))
  if (!line) {
    return { exitCode: result.status ?? 1, setAclCalls: null, final: null }
  }
  const match = /^SETACL=(\d+) FINAL=(.*)$/.exec(line)
  return {
    exitCode: result.status ?? 0,
    setAclCalls: match ? Number.parseInt(match[1], 10) : null,
    final: match ? match[2] : null
  }
}

const FINAL_HARDENED = `${VALID_SID},S-1-5-18,S-1-5-32-544`

type FileCase = {
  name: string
  protectedFlag: boolean
  specs: string[]
  expectSetAcl: 0 | 1
}

const FILE_CASES: FileCase[] = [
  { name: 'owner-only protected', protectedFlag: true, specs: ownerOnly(), expectSetAcl: 0 },
  {
    name: 'inherited owner-only (unprotected)',
    protectedFlag: false,
    specs: ownerOnly(),
    expectSetAcl: 1
  },
  {
    name: 'inherited + Users RX',
    protectedFlag: false,
    specs: [...ownerOnly(), spec('S-1-5-32-545', RX)],
    expectSetAcl: 1
  },
  {
    name: 'protected + CodexSandboxUsers RX',
    protectedFlag: true,
    specs: [...ownerOnly(), spec('S-1-5-21-9-9-9-1234', RX)],
    expectSetAcl: 1
  },
  {
    name: 'protected + user DENY',
    protectedFlag: true,
    specs: [...ownerOnly(), spec(VALID_SID, FC, NONE_INH, PNONE, DENY)],
    expectSetAcl: 1
  },
  {
    name: 'protected SYSTEM+Admins only (no user ACE)',
    protectedFlag: true,
    specs: [spec('S-1-5-18'), spec('S-1-5-32-544')],
    expectSetAcl: 1
  },
  {
    name: 'protected Admins RX',
    protectedFlag: true,
    specs: [spec(VALID_SID), spec('S-1-5-18'), spec('S-1-5-32-544', RX)],
    expectSetAcl: 1
  },
  { name: 'protected EMPTY', protectedFlag: true, specs: [], expectSetAcl: 1 },
  // G1 attempt-4 blocking 2(b): no existing case isolates the allowed-SID check — the two
  // extra-SID cases above are either unprotected (RX, caught earlier by the inheritance
  // throw) or read-only, so a mutant that widens the allowed set or keys the check on the
  // wrong SID never gets exercised (M-a7b, M-a7c both survive all four files).
  {
    name: 'protected + Users FullControl',
    protectedFlag: true,
    specs: [...ownerOnly(), spec('S-1-5-32-545', FC)],
    expectSetAcl: 1
  },
  {
    name: 'protected + Everyone FullControl',
    protectedFlag: true,
    specs: [...ownerOnly(), spec('S-1-1-0', FC)],
    expectSetAcl: 1
  }
]

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle)
  if (index === -1) {
    throw new Error(`mutation anchor not found: ${JSON.stringify(needle)}`)
  }
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length)
}

// Each mutant matches a survivor from the G1 attempt-3 review (blocking 2).
const MUTATIONS: Record<string, (script: string) => string> = {
  'M-a4': (script) =>
    replaceOnce(
      script,
      '} catch {\n  $alreadyRestricted = $false\n}',
      '} catch {\n  $alreadyRestricted = $true\n}'
    ),
  'M-a5': (script) =>
    replaceOnce(script, '} catch {\n  $alreadyRestricted = $false\n}', '} catch {\n}'),
  'M-a6': (script) =>
    replaceOnce(
      script,
      "  if (-not $candidateAcl.AreAccessRulesProtected) {\n    throw 'ACL inheritance is still enabled'\n  }\n",
      ''
    ),
  'M-a8': (script) =>
    replaceOnce(
      script,
      "$allowedSidTexts = @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544')",
      "$allowedSidTexts = @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545')"
    ),
  'M-a9': (script) =>
    replaceOnce(
      script,
      'if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {',
      'if (($rule.FileSystemRights -band $fullControl) -eq 0) {'
    ),
  'M-a10': (script) =>
    replaceOnce(
      script,
      '    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {\n      throw "Unexpected ACL deny entry $sid"\n    }\n',
      ''
    ),
  'M-a11': (script) =>
    replaceOnce(
      script,
      '$foundCurrentUserFullControl = $false',
      '$foundCurrentUserFullControl = $true'
    ),
  // G1 attempt-4 blocking 2(b): the allowed-SID check keyed on the wrong SID — never throws.
  'M-a7b': (script) =>
    replaceOnce(
      script,
      '    if (-not $allowedSids.ContainsKey($sid)) {\n',
      '    if (-not $allowedSids.ContainsKey($currentUserSid)) {\n'
    ),
  // G1 attempt-4 blocking 2(b): the pre-check silently admits BUILTIN\Users while the rebuild
  // (which reads $allowedSidTexts, not $allowedSids) is unchanged.
  'M-a7c': (script) =>
    replaceOnce(
      script,
      'foreach ($sidText in $allowedSidTexts) {\n  $allowedSids[$sidText] = $true\n}\n',
      "foreach ($sidText in $allowedSidTexts) {\n  $allowedSids[$sidText] = $true\n}\n$allowedSids['S-1-5-32-545'] = $true\n"
    )
}

// The specific diverging FILE_CASES entry that exposes each mutant (measured, G1 attempt 3).
const KILL_TABLE: { mutation: string; caseName: string }[] = [
  { mutation: 'M-a4', caseName: 'inherited owner-only (unprotected)' },
  { mutation: 'M-a5', caseName: 'inherited owner-only (unprotected)' },
  { mutation: 'M-a6', caseName: 'inherited owner-only (unprotected)' },
  { mutation: 'M-a8', caseName: 'inherited owner-only (unprotected)' },
  { mutation: 'M-a9', caseName: 'protected Admins RX' },
  { mutation: 'M-a10', caseName: 'protected + user DENY' },
  { mutation: 'M-a11', caseName: 'protected SYSTEM+Admins only (no user ACE)' },
  { mutation: 'M-a7b', caseName: 'protected + Everyone FullControl' },
  { mutation: 'M-a7c', caseName: 'protected + Users FullControl' }
]

describe('secure-path-windows-acl decision-table harness (G1 round-3 item 3, pwsh-gated)', () => {
  it.skipIf(!pwshAvailable)(
    `the real file script matches the 8-case decision table${pwshSkipNote}`,
    () => {
      const script = buildWindowsRestrictAclScriptForTests(
        'C:\\Users\\me\\.orca\\secret.json',
        VALID_SID,
        false
      )
      for (const testCase of FILE_CASES) {
        const result = runCase(script, testCase.protectedFlag, testCase.specs)
        expect(result.setAclCalls, testCase.name).toBe(testCase.expectSetAcl)
        if (testCase.expectSetAcl === 1) {
          expect(result.final, testCase.name).toBe(FINAL_HARDENED)
        }
      }
    }
  )

  it.skipIf(!pwshAvailable)(
    `a directory always gets Set-Acl regardless of prior protection${pwshSkipNote}`,
    () => {
      const script = buildWindowsRestrictAclScriptForTests('C:\\Users\\me\\.orca', VALID_SID, true)
      const result = runCase(script, true, ownerOnly(CIOI))
      expect(result.setAclCalls).toBe(1)
    }
  )

  it.skipIf(!pwshAvailable)(
    `a Set-Acl that leaves the ACL unchanged exits non-zero${pwshSkipNote}`,
    () => {
      const script = buildWindowsRestrictAclScriptForTests(
        'C:\\Users\\me\\.orca\\secret.json',
        VALID_SID,
        false
      )
      const result = runCase(script, false, [...ownerOnly(), spec('S-1-5-32-545', RX)], true)
      expect(result.exitCode).not.toBe(0)
    }
  )

  it.skipIf(!pwshAvailable)(
    `the harness kills M-a4, M-a5, M-a6, M-a7b, M-a7c, M-a8, M-a9, M-a10 and M-a11${pwshSkipNote}`,
    () => {
      const script = buildWindowsRestrictAclScriptForTests(
        'C:\\Users\\me\\.orca\\secret.json',
        VALID_SID,
        false
      )
      const casesByName = new Map(FILE_CASES.map((c) => [c.name, c]))

      for (const { mutation, caseName } of KILL_TABLE) {
        const testCase = casesByName.get(caseName)!
        const mutatedScript = MUTATIONS[mutation](script)
        const mutatedResult = runCase(mutatedScript, testCase.protectedFlag, testCase.specs)
        if (mutation === 'M-a8') {
          expect(mutatedResult.final, mutation).not.toBe(FINAL_HARDENED)
          expect(mutatedResult.final, mutation).toContain('S-1-5-32-545')
        } else {
          // G1 attempt-4 nit: `not.toBe(expected)` also passes if the mutant crashes and
          // returns null (setAclCalls: null !== 1). Assert the specific wrong outcome instead —
          // every KILL_TABLE case here neutralizes the pre-check's throw, so the wrongly
          // "already restricted" DACL skips Set-Acl entirely (0, not the expected 1).
          expect(testCase.expectSetAcl, mutation).toBe(1)
          expect(mutatedResult.setAclCalls, mutation).toBe(0)
        }
      }
    }
  )
})
