import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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

  it('also honours the lock beside the real credentials file behind a symlink', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'orca-cli-lock-real-'))
    try {
      const realCredentials = join(realDir, 'creds.json')
      writeFileSync(realCredentials, '{}')
      symlinkSync(realCredentials, join(configDir, '.credentials.json'))
      writeLock(`${realCredentials}.lock`)
      let settled: string | null = null
      const wait = waitForClaudeCliRefreshLock(configDir, { timeoutMs: 1_000 }).then(
        (result) => (settled = result)
      )

      await vi.advanceTimersByTimeAsync(500)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      await wait
      expect(settled).toBe('timed-out')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })

  it('does not wait on a lock beside the symlink itself when the real file differs', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'orca-cli-lock-real-'))
    try {
      const realCredentials = join(realDir, 'creds.json')
      writeFileSync(realCredentials, '{}')
      symlinkSync(realCredentials, join(configDir, '.credentials.json'))
      // A lock beside the link is not the CLI's lock; only the real file's counts.
      writeLock(join(configDir, '.credentials.json.lock'))
      await expect(waitForClaudeCliRefreshLock(configDir)).resolves.toBe('clear')
    } finally {
      rmSync(realDir, { recursive: true, force: true })
    }
  })
})
