import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { getDaemonPidPath, getDaemonSocketPath, serializeDaemonPidFile } from './daemon-spawner'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(predicate()).toBe(true)
}

// FX-2: an unreapable PTY makes the shutdown dispose fail twice; the PID record is the only handle a launcher has on the still-running process.
describe('DaemonServer shutdown RPC with a dispose that fails and is retried', () => {
  let dir: string
  let server: DaemonServer
  let client: DaemonClient | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-server-rpc-retry-'))
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps its PID record through the retry and releases client sockets before awaiting it', async () => {
    const socketPath = getDaemonSocketPath(dir)
    const tokenPath = join(dir, 'test.token')
    const pidPath = getDaemonPidPath(dir)
    const launchNonce = 'rpc-shutdown-retry'
    const onRpcShutdown = vi.fn()
    writeFileSync(
      pidPath,
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: null, launchNonce })
    )
    server = new DaemonServer({
      socketPath,
      tokenPath,
      pidPath,
      launchNonce,
      onRpcShutdown,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    const daemon = server as unknown as {
      host: { dispose: () => Promise<void> }
      clients: Map<string, { controlSocket: { destroyed: boolean } }>
    }
    const retry = Promise.withResolvers<void>()
    const dispose = vi.fn<() => Promise<void>>()
    dispose
      .mockRejectedValueOnce(new Error('Timed out waiting for PTY process exit: s1'))
      .mockReturnValueOnce(retry.promise)
    daemon.host.dispose = dispose
    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    const controlSocket = [...daemon.clients.values()][0].controlSocket

    await expect(client.request('shutdown', { killSessions: true })).resolves.toEqual({})
    try {
      await waitFor(() => dispose.mock.calls.length === 2)

      // The retry is still pending: pipe instances must already be released, the record must remain.
      await waitFor(() => controlSocket.destroyed)
      expect(daemon.clients.size).toBe(0)
      expect(existsSync(pidPath)).toBe(true)
      expect(onRpcShutdown).not.toHaveBeenCalled()
    } finally {
      retry.resolve()
    }

    await waitFor(() => onRpcShutdown.mock.calls.length === 1)
    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(false)
  })
})
