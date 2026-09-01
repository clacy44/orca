import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDaemonPidPath } from './daemon-spawner'
import { getLinuxDaemonBinaryHealth, getProcessStartedAtMs } from './daemon-health'

// S10-12 R3: Linux mirror of daemon-tcc-attribution.test.ts's macOS harness — a real spawned
// process, because the health check only trusts a pid record whose process is verifiably
// the daemon (readVerifiedDaemonPid), not a mocked identity.
function spawnDaemonLikeProcess(socketPath: string, tokenPath: string) {
  return spawn(
    process.execPath,
    [
      '-e',
      'setTimeout(() => {}, 30000)',
      'daemon-entry',
      '--socket',
      socketPath,
      '--token',
      tokenPath
    ],
    { stdio: 'ignore' }
  )
}

async function getStartedAtMs(pid: number | undefined): Promise<number | null> {
  if (!pid) {
    return null
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  return getProcessStartedAtMs(pid)
}

describe('Linux daemon binary health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-linux-binary-health-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function withDaemonLikeProcess(
    run: (writePidFile: (extra: Record<string, unknown>) => void) => Promise<void>
  ): Promise<void> {
    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }
      const writePidFile = (extra: Record<string, unknown>): void => {
        writeFileSync(
          getDaemonPidPath(dir),
          JSON.stringify({ pid: child.pid, startedAtMs, ...extra }),
          { mode: 0o600 }
        )
      }
      await run(writePidFile)
    } finally {
      child.kill('SIGKILL')
    }
  }

  it('reports severed when the recorded entry path no longer exists (mount torn down)', async () => {
    if (process.platform !== 'linux') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({ entryPath: join(dir, 'tmp-mount-orcaXXXX', 'daemon-entry.js') })
      expect(await getLinuxDaemonBinaryHealth(dir, socketPath, tokenPath)).toBe('severed')
    })
  })

  it('reports intact when the recorded entry path still exists', async () => {
    if (process.platform !== 'linux') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const entryPath = join(dir, 'daemon-entry.js')
      writeFileSync(entryPath, '', 'utf8')
      writePidFile({ entryPath })
      expect(await getLinuxDaemonBinaryHealth(dir, socketPath, tokenPath)).toBe('intact')
    })
  })

  it('fails open without a recorded entry path', async () => {
    if (process.platform !== 'linux') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(await getLinuxDaemonBinaryHealth(dir, socketPath, tokenPath)).toBe('unknown')
    })
  })

  it('fails open when no verifiable pid record exists', async () => {
    if (process.platform !== 'linux') {
      return
    }
    expect(await getLinuxDaemonBinaryHealth(dir, socketPath, tokenPath)).toBe('unknown')
  })

  it('reports unknown off Linux', async () => {
    if (process.platform === 'linux') {
      return
    }
    expect(await getLinuxDaemonBinaryHealth(dir, socketPath, tokenPath)).toBe('unknown')
  })
})
