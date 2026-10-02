import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS, Session } from './session'

// N1: after a Windows tree kill took the root, no later dispose may signal its (possibly recycled) PID.
function createSubprocess() {
  return {
    pid: 4321,
    forceKill: vi.fn(),
    kill: vi.fn(),
    signal: vi.fn(),
    dispose: vi.fn(),
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    onData() {},
    onExit() {}
  }
}

describe('Session.waitForExitAndDisposeSubprocess', () => {
  let session: Session | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('N1: a retry dispose after a timed-out exit wait never signals the root pid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const subprocess = createSubprocess()
    session = new Session({
      sessionId: 'tree-killed',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false
    })

    // First dispose: the tree kill exited 0 but the physical exit never arrives.
    const first = session.waitForExitAndDisposeSubprocess()
    const firstOutcome = first.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
    expect(await firstOutcome).toMatch(/Timed out waiting for PTY process exit/)

    // Retry dispose (terminal-host keeps failed owners retryable): the regular route, which force-kills by pid.
    const retry = session.forceKillAndDisposeSubprocess()
    const retryOutcome = retry.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await vi.advanceTimersByTimeAsync(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
    expect(await retryOutcome).toMatch(/Timed out waiting for PTY process exit/)

    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(subprocess.kill).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exit wait after tree kill timed out')
    )
  })
})
