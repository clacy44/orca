// Reveal pass-through for attachMainWindowServices; kept apart from attach-main-window-services.test.ts,
// which is at its max-lines ceiling.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const { onMock, removeListenerMock } = vi.hoisted(() => ({
  onMock: vi.fn(),
  removeListenerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn() },
  ipcMain: {
    on: onMock,
    removeAllListeners: vi.fn(),
    removeListener: removeListenerMock,
    removeHandler: vi.fn(),
    handle: vi.fn()
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))
vi.mock('../ipc/repos', () => ({
  registerRepoHandlers: vi.fn(),
  setRepoRemoteClientNotifier: vi.fn()
}))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../memory/hydrate-local-pty-registry', () => ({ hydrateLocalPtyRegistryAtBoot: vi.fn() }))
vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  setupAutoUpdater: vi.fn()
}))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn(),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))

import { attachMainWindowServices } from './attach-main-window-services'

type RevealNotifier = {
  revealTerminalSession: (worktreeId: string, opts: Record<string, unknown>) => Promise<unknown>
}

function attach(): {
  notifier: RevealNotifier
  sendMock: ReturnType<typeof vi.fn>
  webContents: unknown
} {
  const sendMock = vi.fn()
  const webContents = {
    id: 1,
    getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => true),
    on: vi.fn(),
    reload: vi.fn(),
    send: sendMock,
    session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
  }
  const mainWindow = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents
  }
  const runtime = {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    markRendererReloading: vi.fn(),
    markRendererReloadCancelled: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
  const store = {
    getProfileStorageDirectory: vi.fn(() => '/profile-a'),
    flushPendingAsync: vi.fn(() => Promise.resolve())
  } as unknown as Store
  attachMainWindowServices(mainWindow as never, store, runtime as never)
  return { notifier: runtime.setNotifier.mock.calls[0][0] as RevealNotifier, sendMock, webContents }
}

describe('attachMainWindowServices terminal reveal', () => {
  beforeEach(() => {
    onMock.mockReset()
    removeListenerMock.mockReset()
  })

  it('passes the materialize-only reveal fields through and accepts an owned receipt', async () => {
    const { notifier, sendMock, webContents } = attach()
    const reveal = notifier.revealTerminalSession('worktree-1', {
      ptyId: 'pty-live',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      splitFromLeafId: 'leaf-first',
      title: 'claude',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '--x', agentEnv: {} },
      activate: false,
      focus: false,
      presentation: 'background',
      materializeOnly: true,
      expectedProcessIdentity: { terminalHandle: 'term_live', incarnationId: 'inc-live' }
    })
    const payload = sendMock.mock.calls.at(-1)?.[1]
    expect(payload).toMatchObject({
      worktreeId: 'worktree-1',
      ptyId: 'pty-live',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      splitFromLeafId: 'leaf-first',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '--x', agentEnv: {} },
      activate: false,
      focus: false,
      presentation: 'background',
      materializeOnly: true
    })
    expect(payload).not.toHaveProperty('launchToken')

    const handler = onMock.mock.calls.findLast(
      ([channel]) => channel === 'terminal:tabCreateReply'
    )?.[1]
    // An owned receipt names the tab that already records the pty; it is not an identity mismatch.
    handler?.(
      { sender: webContents },
      { requestId: payload.requestId, tabId: 'tab-saved', skipped: 'owned' }
    )
    await expect(reveal).resolves.toEqual({ tabId: 'tab-saved', skipped: 'owned' })
  })

  it('still rejects a non-owned reply whose identity differs from the expected one', async () => {
    const { notifier, sendMock, webContents } = attach()
    const reveal = notifier.revealTerminalSession('worktree-1', {
      ptyId: 'pty-live',
      tabId: 'tab-live',
      leafId: 'leaf-live',
      materializeOnly: true,
      expectedProcessIdentity: { terminalHandle: 'term_live', incarnationId: 'inc-live' }
    })
    const payload = sendMock.mock.calls.at(-1)?.[1]
    const handler = onMock.mock.calls.findLast(
      ([channel]) => channel === 'terminal:tabCreateReply'
    )?.[1]
    handler?.(
      { sender: webContents },
      {
        requestId: payload.requestId,
        tabId: 'tab-other',
        identity: {
          worktreeId: 'worktree-1',
          tabId: 'tab-other',
          leafId: 'leaf-live',
          ptyId: 'pty-live'
        }
      }
    )
    await expect(reveal).rejects.toThrow('terminal_reveal_identity_mismatch')
  })

  it('omits materializeOnly from an ordinary reveal', () => {
    const { notifier, sendMock } = attach()
    void notifier.revealTerminalSession('worktree-1', { ptyId: 'pty-plain' }).catch(() => {})
    expect(sendMock.mock.calls.at(-1)?.[1]).not.toHaveProperty('materializeOnly')
  })
})
