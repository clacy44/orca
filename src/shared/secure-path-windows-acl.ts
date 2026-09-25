import { execFile, execFileSync } from 'node:child_process'
import { win32 as pathWin32 } from 'node:path'
import { encodePowerShellCommand } from './powershell-command-encoding'

let cachedWindowsUserSid: string | null | undefined

// P1: Windows PowerShell 5.1 does not bind $args when trailing args follow -Command — every
// prior run threw before touching the ACL, so the file was never actually hardened. Values are
// now embedded as PowerShell single-quoted literals (validated first) and the whole script is
// launched via -EncodedCommand so no shell/argv quoting applies; $args is never read.
const WINDOWS_SID_PATTERN = /^S-1-[0-9-]+$/
const WINDOWS_DIRECTORY_FLAG_PATTERN = /^[01]$/

function assertValidWindowsUserSid(sid: string): void {
  if (!WINDOWS_SID_PATTERN.test(sid)) {
    throw new Error(`Refusing to harden: invalid Windows SID: ${sid}`)
  }
}

function assertValidDirectoryFlag(flag: string): void {
  if (!WINDOWS_DIRECTORY_FLAG_PATTERN.test(flag)) {
    throw new Error(`Refusing to harden: invalid directory flag: ${flag}`)
  }
}

// G1 repair (item 5): directories always take the rebuild branch (never verify-first) and
// Set-Acl propagates recursively to the whole tree, so they need more time than a single file.
const WINDOWS_RESTRICT_ACL_FILE_TIMEOUT_MS = 5000
const WINDOWS_RESTRICT_ACL_DIRECTORY_TIMEOUT_MS = 20000

function windowsRestrictAclTimeoutMs(isDirectory: boolean): number {
  return isDirectory
    ? WINDOWS_RESTRICT_ACL_DIRECTORY_TIMEOUT_MS
    : WINDOWS_RESTRICT_ACL_FILE_TIMEOUT_MS
}

// G1 repair (item 4): PowerShell's single-quoted-string grammar also treats the Unicode
// "smart quote" single-quote variants (U+2018-U+201B) as terminators (about_Quoting_Rules) —
// only U+0027 was doubled before, so a userData path containing one of them broke the literal.
const POWERSHELL_SINGLE_QUOTE_LIKE = /['‘’‚‛]/g

/** Escapes a value for embedding inside a PowerShell single-quoted string literal. */
function escapePowerShellSingleQuotedLiteral(value: string): string {
  return value.replace(POWERSHELL_SINGLE_QUOTE_LIKE, '$&$&')
}

function buildWindowsRestrictAclArgs(
  targetPath: string,
  currentUserSid: string,
  isDirectory: boolean
): string[] {
  const directoryFlag = isDirectory ? '1' : '0'
  assertValidWindowsUserSid(currentUserSid)
  assertValidDirectoryFlag(directoryFlag)
  const script = buildWindowsRestrictAclScript(targetPath, currentUserSid, directoryFlag)
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShellCommand(script)
  ]
}

/** Fires the async best-effort hardening; resolves true/false once PowerShell actually finishes
 *  (never rejects) so callers can record cache state after completion, not before it starts. */
export function bestEffortRestrictWindowsPath(
  targetPath: string,
  isDirectory: boolean
): Promise<boolean> {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return Promise.resolve(false)
  }
  // Why: async to avoid blocking the main thread — sync PowerShell cold-start (~1-1.5s) on the frequent read path stormed it (#4901).
  return new Promise((resolve) => {
    let args: string[]
    try {
      args = buildWindowsRestrictAclArgs(targetPath, currentUserSid, isDirectory)
    } catch {
      // Why: an invalid SID/flag must never spawn — refuse before any process launch.
      resolve(false)
      return
    }
    execFile(
      getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
      args,
      {
        windowsHide: true,
        timeout: windowsRestrictAclTimeoutMs(isDirectory)
      },
      (error) => {
        // Why: ignore errors — hardening is best-effort; PowerShell ACL APIs may be unavailable or locked down.
        resolve(!error)
      }
    )
  })
}

export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return false
  }
  // Why: file must not be published until its ACL is actually restricted, so block and report real success (read path stays async, #4901).
  try {
    execFileSync(
      getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe'),
      buildWindowsRestrictAclArgs(targetPath, currentUserSid, isDirectory),
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        timeout: windowsRestrictAclTimeoutMs(isDirectory)
      }
    )
    return true
  } catch {
    // Why: best-effort — a failed ACL apply must not crash the write; false leaves the path uncached to retry later.
    return false
  }
}

// Why (item C step 1): verify first and skip Set-Acl when the ACL already matches — re-applying
// an unchanged DACL still bumps the file's ChangeTime, which previously defeated the read-path
// re-harden cache on every subsequent read. Exit codes/messages on a real mismatch are unchanged.
// F4: Confirm-AclRestricted also requires the current user's own SID to carry FullControl (not
// just "no unexpected entries" — an empty protected DACL used to pass) and, for directories,
// requires CI|OI inheritance without InheritOnly, so the check actually matches the rebuild.
function buildWindowsRestrictAclScript(
  targetPath: string,
  currentUserSid: string,
  directoryFlag: string
): string {
  const literalPath = escapePowerShellSingleQuotedLiteral(targetPath)
  const literalSid = escapePowerShellSingleQuotedLiteral(currentUserSid)
  return `
$ErrorActionPreference = 'Stop'
$path = '${literalPath}'
$currentUserSid = '${literalSid}'
$isDirectory = '${directoryFlag}' -eq '1'
$allowedSidTexts = @($currentUserSid, 'S-1-5-18', 'S-1-5-32-544')
$allowedSids = @{}
foreach ($sidText in $allowedSidTexts) {
  $allowedSids[$sidText] = $true
}
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$requiredInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
function Confirm-AclRestricted($candidateAcl) {
  if (-not $candidateAcl.AreAccessRulesProtected) {
    throw 'ACL inheritance is still enabled'
  }
  $foundCurrentUserFullControl = $false
  foreach ($rule in @($candidateAcl.Access)) {
    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if (-not $allowedSids.ContainsKey($sid)) {
      throw "Unexpected ACL entry $sid"
    }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw "Unexpected ACL deny entry $sid"
    }
    if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
      throw "ACL entry $sid does not grant FullControl"
    }
    if ($sid -eq $currentUserSid) {
      if ($isDirectory) {
        $hasRequiredInheritance = ($rule.InheritanceFlags -band $requiredInheritance) -eq $requiredInheritance
        $notInheritOnly = $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::InheritOnly
        if ($hasRequiredInheritance -and $notInheritOnly) {
          $foundCurrentUserFullControl = $true
        }
      } else {
        $foundCurrentUserFullControl = $true
      }
    }
  }
  if (-not $foundCurrentUserFullControl) {
    throw 'Missing required FullControl ACE for current user'
  }
}
$acl = Get-Acl -LiteralPath $path
$alreadyRestricted = $true
try {
  Confirm-AclRestricted $acl
} catch {
  $alreadyRestricted = $false
}
// G1 repair (item 5): verify-first only skips the rebuild for FILES. A directory's first
// propagation can be interrupted by the spawn timeout, and once its root already verifies no
// later run would ever re-propagate to the rest of the tree — directories always rebuild.
if ($isDirectory -or -not $alreadyRestricted) {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }
  $inheritanceFlags = [System.Security.AccessControl.InheritanceFlags]::None
  if ($isDirectory) {
    $inheritanceFlags = $requiredInheritance
  }
  foreach ($sidText in $allowedSidTexts) {
    $sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      $fullControl,
      $inheritanceFlags,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  $verifiedAcl = Get-Acl -LiteralPath $path
  Confirm-AclRestricted $verifiedAcl
}
`.trim()
}

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const output = execFileSync(
      getWindowsSystemToolPath('whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 5000
      }
    ).trim()
    const columns = parseCsvLine(output)
    cachedWindowsUserSid = columns[1] ?? null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function getWindowsSystemToolPath(relativeSystem32Path: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', relativeSystem32Path)
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = undefined
}
