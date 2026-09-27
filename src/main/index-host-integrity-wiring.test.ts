// INV-P-023: index.ts is a ~3800-line Electron bootstrap module unsafe to import directly
// (see index-serve-branch-startup-hook.test.ts's own doc comment for why). This asserts the
// wiring textually: the whenReady callback starts detection and installs the daemon reader
// before the runtime service exists, and records the startup observation only once terminal
// startup services are bound.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX_PATH = join(__dirname, 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf8')

describe('index.ts: INV-P-023 host-integrity wiring', () => {
  it('starts detection and installs the daemon reader before the runtime service is constructed', () => {
    const whenReadyStart = source.indexOf('void app.whenReady().then(async () => {')
    const runtimeServiceStart = source.indexOf('new OrcaRuntimeService(')
    const startDetectionCall = source.indexOf('void startHostIntegrityDetection()')
    const setReaderCall = source.indexOf('setDaemonIntegrityReader(getCurrentDaemonIntegrity)')

    expect(whenReadyStart).toBeGreaterThan(-1)
    expect(runtimeServiceStart).toBeGreaterThan(-1)
    expect(startDetectionCall).toBeGreaterThan(whenReadyStart)
    expect(setReaderCall).toBeGreaterThan(whenReadyStart)
    expect(startDetectionCall).toBeLessThan(runtimeServiceStart)
    expect(setReaderCall).toBeLessThan(runtimeServiceStart)
  })

  it('records the startup observation after bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))', () => {
    const bindCall = source.indexOf(
      'bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))'
    )
    const observationCall = source.indexOf('recordHostIntegrityStartupObservation(')

    expect(bindCall).toBeGreaterThan(-1)
    expect(observationCall).toBeGreaterThan(-1)
    expect(observationCall).toBeGreaterThan(bindCall)
  })
})
