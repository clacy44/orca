// N7 (INV-P-023, G1-10z3-attacker): a sibling of codex-fetcher.test.ts — kept separate so the
// host-integrity gate case does not push codex-fetcher.test.ts's own 800-line test budget over.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { childSpawnMock, resolveCodexCommandMock, ptySpawnMock } = vi.hoisted(() => ({
  childSpawnMock: vi.fn(),
  resolveCodexCommandMock: vi.fn(),
  ptySpawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: childSpawnMock }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))
vi.mock('./codex-auth-presence', () => ({ probeCodexAuthPresence: vi.fn(() => 'present') }))

import { fetchCodexRateLimits } from './codex-fetcher'
import {
  configureHostIntegrityForTests,
  resetHostIntegrityForTests
} from '../host-integrity/host-integrity-guard'
import type { IntegrityProbe } from '../host-integrity/windows-integrity-level'

describe('fetchCodexRateLimits: N7 (INV-P-023) host-integrity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resolveCodexCommandMock.mockReturnValue('codex')
    // RPC path unavailable, so a covered fetch falls through to the PTY fallback under test.
    childSpawnMock.mockImplementation(() => {
      throw new Error('rpc unavailable')
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetHostIntegrityForTests()
  })

  it('skips the PTY usage probe while the host is blocked', async () => {
    configureHostIntegrityForTests({
      probe: async () => ({ level: 'high', detail: 'test' }) satisfies IntegrityProbe,
      env: {}
    })
    await Promise.resolve()
    await Promise.resolve()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await fetchCodexRateLimits()
      expect(result).toMatchObject({ provider: 'codex', status: 'error' })
      expect(ptySpawnMock).not.toHaveBeenCalled()
      expect(
        warnSpy.mock.calls.filter(
          (c) => c[0] === '[host-integrity] usage probe skipped: host blocked (INV-P-023)'
        )
      ).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
