// INV-P-023: formatCliStatus's integrity/integrityWarning lines. New file — MUST NOT TOUCH
// forbids adding tests to format.test.ts (795/800 counted).
import { describe, expect, it } from 'vitest'
import { formatCliStatus } from './format'
import type { CliStatusResult } from '../shared/runtime-types'
import type { RuntimeHostIntegrity } from '../shared/host-integrity-types'

// Exact contract strings (R266 DESIGN Q2 "Sentences") — copied verbatim, not imported, so this
// CLI-project test does not need to pull in the main-only host-integrity-guard module graph.
function hostIntegrityRefusalSentence(
  source: 'main' | 'daemon',
  level: 'high' | 'low' | 'unknown'
): string {
  const subject = source === 'main' ? "Orca's main process" : "Orca's terminal daemon"
  const remedy =
    source === 'main'
      ? 'Relaunch Orca normally from the Start menu (not from an elevated shell)'
      : 'Restart the terminal daemon from this non-elevated Orca (Manage Sessions → Restart)'
  const describe =
    level === 'high'
      ? 'elevated (High integrity)'
      : level === 'low'
        ? 'at Low integrity'
        : 'at an integrity level Orca could not verify'
  return `${subject} is running ${describe}, so new agent sessions are refused. ${remedy}, or set ORCA_ALLOW_ELEVATED=1 to allow them.`
}

function hostIntegrityOverrideSentence(
  source: 'main' | 'daemon',
  level: 'high' | 'low' | 'unknown'
): string {
  const subject = source === 'main' ? "Orca's main process" : "Orca's terminal daemon"
  const describe =
    level === 'high'
      ? 'elevated (High integrity)'
      : level === 'low'
        ? 'at Low integrity'
        : 'at an integrity level Orca could not verify'
  return `${subject} is running ${describe} and ORCA_ALLOW_ELEVATED=1 is set, so agent sessions are allowed and inherit that integrity level.`
}

const DAEMON_UNREPORTED_SENTENCE =
  "Orca's terminal daemon predates the elevation guard and cannot report its integrity level; restart it (Manage Sessions → Restart) to verify it is not elevated."

function status(integrity?: RuntimeHostIntegrity): CliStatusResult {
  return {
    app: { running: true, pid: 123 },
    runtime: {
      state: 'ready',
      reachable: true,
      runtimeId: 'rt-1',
      ...(integrity ? { integrity } : {})
    },
    graph: { state: 'ready' }
  }
}

const SEVEN_LINES = [
  'appRunning: true',
  'pid: 123',
  'desktopWindowStatus: unknown',
  'runtimeState: ready',
  'runtimeReachable: true',
  'runtimeId: rt-1',
  'graphState: ready'
]

describe('formatCliStatus: INV-P-023 integrity lines', () => {
  it('no integrity -> exactly the 7 existing lines', () => {
    expect(formatCliStatus(status())).toBe(SEVEN_LINES.join('\n'))
  })

  it('medium -> appends only integrity: medium', () => {
    const out = formatCliStatus(
      status({ level: 'medium', main: 'medium', elevationAllowed: false, agentLaunch: 'allowed' })
    )
    expect(out).toBe([...SEVEN_LINES, 'integrity: medium'].join('\n'))
  })

  it('high -> integrity: high plus integrityWarning', () => {
    const warning = hostIntegrityRefusalSentence('main', 'high')
    const out = formatCliStatus(
      status({
        level: 'high',
        main: 'high',
        elevationAllowed: false,
        agentLaunch: 'refused',
        warning
      })
    )
    expect(out).toBe([...SEVEN_LINES, 'integrity: high', `integrityWarning: ${warning}`].join('\n'))
  })

  it('main medium, daemon high -> integrity: high (main: medium, terminal daemon: high)', () => {
    const warning = hostIntegrityRefusalSentence('daemon', 'high')
    const out = formatCliStatus(
      status({
        level: 'high',
        main: 'medium',
        daemon: 'high',
        elevationAllowed: false,
        agentLaunch: 'refused',
        warning
      })
    )
    expect(out.split('\n')[7]).toBe('integrity: high (main: medium, terminal daemon: high)')
  })

  it('high with override -> integrity: high [ORCA_ALLOW_ELEVATED=1]', () => {
    const warning = hostIntegrityOverrideSentence('main', 'high')
    const out = formatCliStatus(
      status({
        level: 'high',
        main: 'high',
        elevationAllowed: true,
        agentLaunch: 'allowed',
        warning
      })
    )
    expect(out.split('\n')[7]).toBe('integrity: high [ORCA_ALLOW_ELEVATED=1]')
  })

  it('unknown -> integrity: unknown plus a warning', () => {
    const warning = hostIntegrityRefusalSentence('main', 'unknown')
    const out = formatCliStatus(
      status({
        level: 'unknown',
        main: 'unknown',
        elevationAllowed: false,
        agentLaunch: 'refused',
        warning
      })
    )
    expect(out.split('\n')[7]).toBe('integrity: unknown')
    expect(out.split('\n')[8]).toBe(`integrityWarning: ${warning}`)
  })

  it('medium with daemon unreported -> the unreported sentence', () => {
    const out = formatCliStatus(
      status({
        level: 'medium',
        main: 'medium',
        daemon: 'unreported',
        elevationAllowed: false,
        agentLaunch: 'allowed',
        warning: DAEMON_UNREPORTED_SENTENCE
      })
    )
    expect(out.split('\n')[7]).toBe('integrity: medium (main: medium, terminal daemon: unreported)')
    expect(out.split('\n')[8]).toBe(`integrityWarning: ${DAEMON_UNREPORTED_SENTENCE}`)
  })
})
