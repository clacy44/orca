// G1 round-3 item 1 (CRITICAL repair): round 2 inserted JavaScript `//` comment lines inside the
// PowerShell template (one containing an apostrophe that opened an unterminated single-quoted
// string). The emitted script stopped parsing, so Windows ACL hardening silently no-opped on
// every path. See src/shared/secure-path-windows-acl.ts:130-215.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWindowsRestrictAclScriptForTests } from './secure-path-windows-acl'

const VALID_SID = 'S-1-5-21-1000'
const pwshAvailable =
  spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status === 0
const pwshSkipNote = pwshAvailable ? '' : ' [SKIPPED: pwsh not found on PATH]'

describe('secure-path-windows-acl script syntax (G1 round-3 item 1)', () => {
  it('item 1(a): no emitted script line starts with a JavaScript "//" comment', () => {
    const fileScript = buildWindowsRestrictAclScriptForTests(
      'C:\\Users\\me\\.orca\\secret.json',
      VALID_SID,
      false
    )
    const dirScript = buildWindowsRestrictAclScriptForTests('C:\\Users\\me\\.orca', VALID_SID, true)

    for (const script of [fileScript, dirScript]) {
      const jsCommentLines = script.split('\n').filter((line) => line.trimStart().startsWith('//'))
      expect(jsCommentLines).toEqual([])
    }
  })

  describe('item 1(b): PowerShell parser (pwsh-gated)', () => {
    const scratchDirs: string[] = []

    afterEach(() => {
      while (scratchDirs.length > 0) {
        rmSync(scratchDirs.pop()!, { recursive: true, force: true })
      }
    })

    function parseErrorCount(scriptText: string): { errorCount: number; detail: string } {
      const dir = mkdtempSync(join(tmpdir(), 'acl-parse-'))
      scratchDirs.push(dir)
      const scriptFile = join(dir, 'script.ps1')
      writeFileSync(scriptFile, scriptText, 'utf-8')
      const checker = [
        `$text = [System.IO.File]::ReadAllText('${scriptFile}')`,
        '$tokens = $null',
        '$errors = $null',
        '[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)',
        'Write-Output $errors.Count'
      ].join('\n')
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', checker], {
        encoding: 'utf-8'
      })
      return {
        errorCount: Number.parseInt(result.stdout.trim(), 10),
        detail: `stdout=[${result.stdout}] stderr=[${result.stderr}]`
      }
    }

    it.skipIf(!pwshAvailable)(`the file script parses with zero errors${pwshSkipNote}`, () => {
      const script = buildWindowsRestrictAclScriptForTests(
        'C:\\Users\\me\\.orca\\secret.json',
        VALID_SID,
        false
      )
      const { errorCount, detail } = parseErrorCount(script)
      expect(errorCount, detail).toBe(0)
    })

    it.skipIf(!pwshAvailable)(`the directory script parses with zero errors${pwshSkipNote}`, () => {
      const script = buildWindowsRestrictAclScriptForTests('C:\\Users\\me\\.orca', VALID_SID, true)
      const { errorCount, detail } = parseErrorCount(script)
      expect(errorCount, detail).toBe(0)
    })
  })
})
