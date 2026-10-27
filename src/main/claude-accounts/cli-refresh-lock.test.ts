import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForClaudeCliRefreshLock } from './cli-refresh-lock'

describe('waitForClaudeCliRefreshLock', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'orca-cli-lock-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(configDir, { recursive: true, force: true })
  })

  function writeLock(path: string, ageMs = 0): void {
    writeFileSync(path, '')
    const when = new Date(Date.now() - ageMs)
    utimesSync(path, when, when)
  }

  it('resolves immediately when no lock exists', async () => {
    await expect(waitForClaudeCliRefreshLock(configDir)).resolves.toBe('clear')
  })

  it('waits while a fresh .oauth_refresh.lock exists and resolves once it is released', async () => {
    const lockPath = join(configDir, '.oauth_refresh.lock')
    writeLock(lockPath)
    let settled: string | null = null
    const wait = waitForClaudeCliRefreshLock(configDir).then((result) => (settled = result))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBeNull()

    rmSync(lockPath)
    await vi.advanceTimersByTimeAsync(250)
    await wait
    expect(settled).toBe('clear')
  })

  it('ignores a stale lock', async () => {
    writeLock(join(configDir, '.oauth_refresh.lock'), 61_000)

    await expect(waitForClaudeCliRefreshLock(configDir)).resolves.toBe('clear')
  })

  it('treats a lock directory like a lock file', async () => {
    mkdirSync(join(configDir, '.oauth_refresh.lock'))
    let settled: string | null = null
    const wait = waitForClaudeCliRefreshLock(configDir, { timeoutMs: 2_000 }).then(
      (result) => (settled = result)
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1_500)
    await wait
    expect(settled).toBe('timed-out')
  })

  it('times out at 35 s while the lock stays fresh', async () => {
    writeLock(join(configDir, '.oauth_refresh.lock'))
    let settled: string | null = null
    const wait = waitForClaudeCliRefreshLock(configDir).then((result) => (settled = result))

    await vi.advanceTimersByTimeAsync(34_000)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1_500)
    await wait
    expect(settled).toBe('timed-out')
  })

  it('honours the lock beside the config directory (<dir>.lock)', async () => {
    writeLock(`${realpathSync(configDir)}.lock`)
    let settled: string | null = null
    const wait = waitForClaudeCliRefreshLock(configDir, { timeoutMs: 1_000 }).then(
      (result) => (settled = result)
    )

    await vi.advanceTimersByTimeAsync(500)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    await wait
    expect(settled).toBe('timed-out')
    rmSync(`${realpathSync(configDir)}.lock`, { force: true })
  })

  it('locks beside the REAL directory when the config dir is a symlink', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'orca-cli-lock-real-'))
    const linkPath = `${realDir}-link`
    symlinkSync(realDir, linkPath)
    try {
      writeLock(`${realDir}.lock`)
      let settled: string | null = null
      const wait = waitForClaudeCliRefreshLock(linkPath, { timeoutMs: 1_000 }).then(
        (result) => (settled = result)
      )

      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      await wait
      expect(settled).toBe('timed-out')
    } finally {
      rmSync(`${realDir}.lock`, { force: true })
      rmSync(linkPath, { force: true })
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('ignores a stale <dir>.lock and the old credentials-file lock path', async () => {
    writeLock(`${realpathSync(configDir)}.lock`, 61_000)
    // Not where the CLI locks any more.
    writeLock(join(configDir, '.credentials.json.lock'))

    await expect(waitForClaudeCliRefreshLock(configDir)).resolves.toBe('clear')
    rmSync(`${realpathSync(configDir)}.lock`, { force: true })
  })
})
