import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const commandMocks = vi.hoisted(() => ({
  resolveClaudeCommand: vi.fn(() => 'claude')
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: commandMocks.resolveClaudeCommand
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

type FakeChild = EventEmitter & {
  pid?: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  if (pid !== undefined) {
    child.pid = pid
  }
  return child
}

const CONFIG_DIR = { windowsPath: '/tmp/claude-auth', linuxPath: null, wslDistro: null }

describe('spawnClaudeCliChildProcess', () => {
  beforeEach(() => {
    setPlatform('linux')
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('node:child_process')
    vi.useRealTimers()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('fires onStdoutChunk/onStderrChunk with raw chunks, before any caller accumulation', async () => {
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const { result } = spawnClaudeCliChildProcess(['auth', 'status', '--json'], CONFIG_DIR, 1000, {
      onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
      onStderrChunk: (chunk) => stderrChunks.push(chunk)
    })

    child.stdout.write('first ')
    child.stdout.write('second')
    child.stderr.write('warn')
    await new Promise((r) => queueMicrotask(() => r(undefined)))
    child.emit('close', 0)

    expect(await result).toEqual({ code: 0 })
    // MP: a caller that only sees the accumulated/truncated buffer (rather than
    // each raw chunk as it arrives) could not have observed these as two calls.
    expect(stdoutChunks).toEqual(['first ', 'second'])
    expect(stderrChunks).toEqual(['warn'])
  })

  it('resolves with the exit code even on a non-zero exit — the caller decides pass/fail', async () => {
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const { result } = spawnClaudeCliChildProcess(['auth', 'status', '--json'], CONFIG_DIR, 1000)
    child.emit('close', 1)

    await expect(result).resolves.toEqual({ code: 1 })
  })

  it('kill() tears down the process group on posix via process.kill(-pid)', async () => {
    const child = createFakeChild(4242)
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const killTree = vi.spyOn(process, 'kill').mockReturnValue(true)

    try {
      const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')
      const { handle, result } = spawnClaudeCliChildProcess(
        ['auth', 'login', '--claudeai'],
        CONFIG_DIR,
        1000,
        { keepStdinOpen: true }
      )

      handle.kill(new Error('denied'))

      await expect(result).rejects.toThrow('denied')
      expect(killTree).toHaveBeenCalledWith(-4242)
      expect(child.kill).not.toHaveBeenCalled()
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
    } finally {
      killTree.mockRestore()
    }
  })

  it('kill() uses taskkill on win32 (mocked) instead of process.kill', async () => {
    setPlatform('win32')
    vi.resetModules()
    const child = createFakeChild(1234)
    const taskkill = new EventEmitter()
    const spawnMock = vi.fn((command: string) => (command === 'taskkill.exe' ? taskkill : child))
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const killTree = vi.spyOn(process, 'kill')

    try {
      const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')
      const { handle, result } = spawnClaudeCliChildProcess(
        ['auth', 'login', '--claudeai'],
        CONFIG_DIR,
        1000,
        { keepStdinOpen: true }
      )

      handle.kill(new Error('cancelled'))

      expect(spawnMock).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/pid', '1234', '/t', '/f'],
        expect.objectContaining({ stdio: 'ignore', windowsHide: true })
      )
      expect(killTree).not.toHaveBeenCalled()
      taskkill.emit('close', 0)
      await expect(result).rejects.toThrow('cancelled')
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      killTree.mockRestore()
    }
  })

  it('rejects with the default timeout message and kills the child', async () => {
    vi.useFakeTimers()
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const { result } = spawnClaudeCliChildProcess(['login'], CONFIG_DIR, 1000, {
      keepStdinOpen: true
    })
    const rejection = expect(result).rejects.toThrow('Claude sign-in took too long to finish.')
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('honors a custom timeoutMessage', async () => {
    vi.useFakeTimers()
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const { result } = spawnClaudeCliChildProcess(['login'], CONFIG_DIR, 1000, {
      timeoutMessage: 'custom timeout'
    })
    const rejection = expect(result).rejects.toThrow('custom timeout')
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
  })

  it('rejects with the cancel message when the abort signal fires', async () => {
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const controller = new AbortController()
    const { result } = spawnClaudeCliChildProcess(['login'], CONFIG_DIR, 5000, {
      signal: controller.signal
    })
    controller.abort()

    await expect(result).rejects.toThrow('Claude sign-in was cancelled.')
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('writeStdin writes to the child stdin', async () => {
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const write = vi.spyOn(child.stdin, 'write')
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const { handle } = spawnClaudeCliChildProcess(['login'], CONFIG_DIR, 1000, {
      keepStdinOpen: true
    })
    handle.writeStdin('123456\n')

    expect(write).toHaveBeenCalledWith('123456\n')
  })

  // MP: kill() must be a no-op once the run has already settled — a stray
  // second call (e.g. a denial detected right as the process also exits)
  // must not re-enter cleanup or re-reject an already-resolved result.
  it('kill() after settle is a no-op', async () => {
    const child = createFakeChild()
    const spawnMock = vi.fn(() => child)
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }))
    const { spawnClaudeCliChildProcess } = await import('./claude-cli-child-process')

    const { handle, result } = spawnClaudeCliChildProcess(['login'], CONFIG_DIR, 1000)
    child.emit('close', 0)
    await expect(result).resolves.toEqual({ code: 0 })

    expect(() => handle.kill(new Error('too late'))).not.toThrow()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
