// INV-P-023: index.ts is a ~3800-line Electron bootstrap module unsafe to import directly
// (see index-serve-branch-startup-hook.test.ts's own doc comment for why). This asserts the
// wiring textually: the whenReady callback starts detection and installs the daemon reader
// before the runtime service exists, and records the startup observation only once terminal
// startup services are bound.
//
// N2 (G1-10z3-attacker M11a/M11c): a plain source.indexOf() over raw text still finds a call
// commented out (the comment text still contains the substring) or an observation dead-coded
// behind `if (false)` (the substring is still present, just unreachable). Comments are stripped
// first, and each call is anchored to its own statement line so both survive as failures.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX_PATH = join(__dirname, 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf8')

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function statementLineIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text)
  return match ? match.index : -1
}

const codeOnly = stripComments(source)

describe('index.ts: INV-P-023 host-integrity wiring', () => {
  it('starts detection and installs the daemon reader before the runtime service is constructed', () => {
    const whenReadyStart = codeOnly.indexOf('void app.whenReady().then(async () => {')
    const runtimeServiceStart = codeOnly.indexOf('new OrcaRuntimeService(')
    const startDetectionCall = statementLineIndex(
      codeOnly,
      /^\s*void startHostIntegrityDetection\(\)\s*$/m
    )
    const setReaderCall = statementLineIndex(
      codeOnly,
      /^\s*setDaemonIntegrityReader\(getCurrentDaemonIntegrity\)\s*$/m
    )

    expect(whenReadyStart).toBeGreaterThan(-1)
    expect(runtimeServiceStart).toBeGreaterThan(-1)
    expect(startDetectionCall).toBeGreaterThan(whenReadyStart)
    expect(setReaderCall).toBeGreaterThan(whenReadyStart)
    expect(startDetectionCall).toBeLessThan(runtimeServiceStart)
    expect(setReaderCall).toBeLessThan(runtimeServiceStart)
  })

  it('records the startup observation after bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))', () => {
    const bindCall = codeOnly.indexOf(
      'bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))'
    )
    // Anchored to the statement's own first line (not the nested call substring): a mutant that
    // dead-codes the statement behind `if (false as boolean) void localPtyProviderStartupReady`
    // no longer has a line starting with exactly `void localPtyProviderStartupReady`.
    const observationStatement = statementLineIndex(
      codeOnly,
      /^\s*void localPtyProviderStartupReady\s*$/m
    )
    const observationCall = codeOnly.indexOf('recordHostIntegrityStartupObservation(')

    expect(bindCall).toBeGreaterThan(-1)
    expect(observationStatement).toBeGreaterThan(-1)
    expect(observationCall).toBeGreaterThan(-1)
    expect(observationStatement).toBeGreaterThan(bindCall)
    expect(observationCall).toBeGreaterThan(observationStatement)
  })
})
