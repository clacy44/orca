// S10-21a C7 (design v3.2 §2.1a, T24): "with the lock held … a renderer-invoked restore attempt
// … either waits for the lock or is refused outright — it must never consume a launch-table row
// or mint a competing pane for that pane_key while the lock is held. After the sweep releases
// the lock, the renderer path behaves as it does today."
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  acquireRestoreSweepLock,
  releaseRestoreSweepLock,
  _resetRestoreSweepLockForTest
} from './restore-sweep-lock'
import { LaunchAdmissionRefusedError } from '../ipc/agent-launch-admission-errors'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function stubLaunchScope(runtime: OrcaRuntimeService): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
      id: string
      path: string
      connectionId: string | null
      repo: null
      folderWorkspace: null
    }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

describe('S10-21a C7, T24: createTerminal refuses a placed, non-host-restore create while the sweep lock is held', () => {
  afterEach(() => {
    _resetRestoreSweepLockForTest()
  })

  it('refuses sweep_lock_held for a placed caller create while the lock is held', async () => {
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = randomUUID()
    acquireRestoreSweepLock()
    try {
      await expect(
        runtime.createTerminal('id:wt-1', {
          restoreProvenance: { kind: 'none' },
          credentialLane: { kind: 'shared' },
          tabId: 'tab1',
          leafId
        })
      ).rejects.toMatchObject({
        constructor: LaunchAdmissionRefusedError,
        reasonCode: 'sweep_lock_held'
      })
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      releaseRestoreSweepLock()
    }
  })

  it('behaves as today (no sweep_lock_held refusal) once the lock is released', async () => {
    const runtime = new OrcaRuntimeService()
    stubLaunchScope(runtime)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const leafId = randomUUID()
    acquireRestoreSweepLock()
    releaseRestoreSweepLock()
    await expect(
      runtime.createTerminal('id:wt-1', {
        restoreProvenance: { kind: 'none' },
        credentialLane: { kind: 'shared' },
        tabId: 'tab2',
        leafId
      })
    ).resolves.toBeDefined()
  })
})
