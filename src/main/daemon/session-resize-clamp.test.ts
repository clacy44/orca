// R3 (D-26b): an unclamped resize makes the headless emulator allocate every row synchronously.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, type SubprocessHandle } from './session'
import { createResizeRejectedLog, isValidPtySize, normalizePtySize } from './daemon-pty-size'

function createSubprocess(): SubprocessHandle & {
  resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>
} {
  return {
    pid: 4242,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    dispose: vi.fn()
  }
}

describe('PTY size bounds', () => {
  it('accepts whole sizes inside 4096x2048 and rejects the rest', () => {
    expect(isValidPtySize(80, 24)).toBe(true)
    expect(isValidPtySize(4096, 2048)).toBe(true)
    expect(isValidPtySize(4097, 24)).toBe(false)
    expect(isValidPtySize(80, 2049)).toBe(false)
    expect(isValidPtySize(80, 100000)).toBe(false)
    expect(isValidPtySize(80.5, 24)).toBe(false)
    expect(isValidPtySize(0, 24)).toBe(false)
    expect(isValidPtySize(Number.NaN, 24)).toBe(false)
  })

  it('falls back to 80x24 at creation for an out-of-range size', () => {
    expect(normalizePtySize(80, 100000)).toEqual({ cols: 80, rows: 24 })
  })
})

describe('Session.resize clamp', () => {
  let session: Session | null = null
  afterEach(() => {
    session?.dispose()
    session = null
  })

  it('keeps the applied size and reports one rate-limited resize-rejected line', () => {
    const log = { log: vi.fn(), close: vi.fn() }
    const logResizeRejected = createResizeRejectedLog(log)
    const subprocess = createSubprocess()
    session = new Session({
      sessionId: 'pty-session-resize-clamp',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false,
      onResizeRejected: (size) => logResizeRejected('pty-session-resize-clamp', size)
    })

    session.resize(80, 100000)
    session.resize(80, 100000)

    expect(session.getAppliedSize()).toEqual({ cols: 80, rows: 24 })
    expect(subprocess.resize).not.toHaveBeenCalled()
    expect(log.log).toHaveBeenCalledTimes(1)
    expect(log.log).toHaveBeenCalledWith('resize-rejected', {
      sessionIdSuffix: 'size-clamp',
      cols: 80,
      rows: 100000
    })
  })

  it('still applies a valid resize', () => {
    const subprocess = createSubprocess()
    session = new Session({
      sessionId: 'pty-session-resize-ok',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false,
      onResizeRejected: vi.fn()
    })
    session.resize(4096, 2048)
    expect(session.getAppliedSize()).toEqual({ cols: 4096, rows: 2048 })
    expect(subprocess.resize).toHaveBeenCalledWith(4096, 2048)
  })
})
