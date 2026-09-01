/**
 * S10-12 acceptance tests (R5) — the chair-ruling reproduction targets from the daemon-death
 * diagnosis, run against real components: a real DaemonServer + socket, a real DaemonPtyAdapter/
 * DaemonClient, and a real OrcaRuntimeService. The one piece not exercised here is pty.ts's
 * Electron-scoped wiring itself (module-level provider registry, ipcMain, BrowserWindow) — the
 * three lines that call `runtime.notifyPtyProviderTransportDisconnected` on
 * `localProvider.onTransportDisconnected` are reproduced directly against the real adapter
 * instead, since that wiring has no daemon-death logic of its own to exercise.
 *
 * T1 (kill a stub daemon's sockets): 'marks every pty of the provider disconnected...'
 * T2 (SIGKILL the daemon process): DaemonClient.handleDisconnect fires identically on any
 *   socket close/error — a graceful DaemonServer.shutdown() and a killed real process both
 *   reach it the same way, so T1's harness is this client-detection layer's T2 too. A full
 *   process-level SIGKILL run needs a built daemon-entry.js and was not attempted here.
 * T5 (no regression on the sound restart flow): included below.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'
import { OrcaRuntimeService } from '../runtime/orca-runtime'

const WORKTREE_ID = 'repo-1::/tmp/s10-12-worktree'

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 999_999_998,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: () => setTimeout(() => onExitCb?.(0), 5),
    forceKill: () => setTimeout(() => onExitCb?.(137), 5),
    signal() {},
    onData() {},
    onExit(cb) {
      onExitCb = cb
    },
    dispose() {}
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Mirrors pty.ts's own write() wrapper: DaemonPtyAdapter.write is void-returning and signals
 *  failure by throwing (PtyWriteUnavailableError), but RuntimePtyController.write must answer
 *  a boolean. */
function adapterWrite(adapter: DaemonPtyAdapter, ptyId: string, data: string): boolean {
  try {
    adapter.write(ptyId, data)
    return true
  } catch {
    return false
  }
}

/** Reproduces pty.ts's bindProviderListeners wiring for onTransportDisconnected — the actual
 *  IPC/window plumbing around it has no daemon-death logic of its own. */
function wireTransportDisconnected(
  adapter: DaemonPtyAdapter,
  runtime: OrcaRuntimeService
): () => void {
  return adapter.onTransportDisconnected(() => {
    void runtime.notifyPtyProviderTransportDisconnected(null)
  })
}

function syncLaidOutPane(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'shell',
        activeLeafId: 'pane:1',
        layout: null
      }
    ],
    leaves: [{ tabId: 'tab-1', worktreeId: WORKTREE_ID, leafId: 'pane:1', paneRuntimeId: 1, ptyId }]
  })
}

describe('S10-12 daemon-death acceptance (R5)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 's10-12-acceptance-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('T1: a daemon-survived laid-out pane reads connected=false and refuses send within one sweep of the socket closing', async () => {
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const runtime = new OrcaRuntimeService()
    const unwire = wireTransportDisconnected(adapter, runtime)
    try {
      const { id: ptyId } = await adapter.spawn({ cols: 80, rows: 24 })
      // Why not route through adapter.listProcesses(): it reattempts ensureConnected() against
      // the now-dead endpoint on every call, which is exactly what makes T1 slow in production
      // and is not what this test is verifying — the direct mark (notifyPtyProviderTransportDisconnected)
      // is what T1 is about; this mock stands in for "the daemon inventory no longer lists it".
      let daemonAlive = true
      runtime.setPtyController({
        write: (targetId, data) => adapterWrite(adapter, targetId, data),
        kill: () => true,
        getForegroundProcess: async () => null,
        // Why reject, not []: an empty-but-successful inventory legitimately means "the daemon
        // is alive and confirms this pty is gone" — a different, self-healing-eligible state
        // from "the transport is unreachable", which is what a dead daemon actually produces.
        listProcesses: async () => {
          if (!daemonAlive) {
            throw new Error('endpoint unreachable')
          }
          return [{ id: ptyId, cwd: '', title: 'shell' }]
        }
      })
      syncLaidOutPane(runtime, ptyId)

      const beforeTerminals = await runtime.listTerminals()
      expect(beforeTerminals.terminals[0]).toMatchObject({ connected: true, writable: true })

      // Kill the stub daemon's sockets — the diagnosis's daemon-survived→restart shape.
      const client = (adapter as unknown as { client: { isConnected(): boolean } }).client
      daemonAlive = false
      await server.shutdown()
      await waitFor(() => !client.isConnected())
      // The onTransportDisconnected wiring's notifyPtyProviderTransportDisconnected is async;
      // give its microtask/promise chain a turn before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20))

      const afterTerminals = await runtime.listTerminals()
      expect(afterTerminals.terminals[0]).toMatchObject({ connected: false, writable: false })

      await expect(
        runtime.sendTerminal(afterTerminals.terminals[0].handle, { text: 'hello' })
      ).rejects.toMatchObject({ code: 'no_connected_pty' })
    } finally {
      unwire()
      adapter.dispose()
    }
  })

  it('T5: no regression on the sound restart flow — daemon survives, a fresh adapter adopts, terminals stay live and writable', async () => {
    const firstAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const runtime = new OrcaRuntimeService()
    let ptyId: string
    try {
      ptyId = (await firstAdapter.spawn({ cols: 80, rows: 24 })).id
    } finally {
      // Why disconnectOnly, not dispose: the daemon (DaemonServer, still running) must
      // survive this client detaching, matching a "serve stopped, daemon preserved" restart.
      await firstAdapter.disconnectOnly()
    }

    // A fresh adapter — the new serve's own adoption — reconnects to the SAME still-alive daemon.
    const secondAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const unwire = wireTransportDisconnected(secondAdapter, runtime)
    try {
      // Attach-only adoption of the daemon-persisted session — mirrors the real adoption flow
      // (a fresh adapter instance must attach before it may write/read a pre-existing session).
      await secondAdapter.attach(ptyId)
      runtime.setPtyController({
        write: (targetId, data) => adapterWrite(secondAdapter, targetId, data),
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => secondAdapter.listProcesses()
      })
      syncLaidOutPane(runtime, ptyId)

      const terminals = await runtime.listTerminals()
      expect(terminals.terminals[0]).toMatchObject({ connected: true, writable: true })

      await expect(
        runtime.sendTerminal(terminals.terminals[0].handle, { text: 'still here' })
      ).resolves.toMatchObject({ accepted: true })
    } finally {
      unwire()
      secondAdapter.dispose()
    }
  })
})
