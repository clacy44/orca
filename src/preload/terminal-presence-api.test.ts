import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from './api-types'
import type { TerminalPresenceLocalTerminal } from '../shared/terminal-presence-ipc'

const { exposeInMainWorld, invoke, on, removeListener, send, sendSync } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener, send, sendSync },
  webFrame: {
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    setVisualZoomLevelLimits: vi.fn()
  },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

vi.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }))

const TERMINAL: TerminalPresenceLocalTerminal = {
  ptyId: 'pty-local-1',
  handle: 'terminal-7',
  participants: []
}

describe('terminalPresence preload surface', () => {
  const originalContextIsolated = Object.getOwnPropertyDescriptor(process, 'contextIsolated')

  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockReset()
    invoke.mockReset()
    on.mockReset()
    removeListener.mockReset()
    Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('document', { addEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalContextIsolated) {
      Object.defineProperty(process, 'contextIsolated', originalContextIsolated)
    } else {
      Reflect.deleteProperty(process, 'contextIsolated')
    }
  })

  it('hydrates through terminalPresence:get and unsubscribes its change listener', async () => {
    invoke.mockResolvedValueOnce({ host: null, terminals: [TERMINAL] })
    await import('./index')
    const api = exposeInMainWorld.mock.calls.find(([name]) => name === 'api')?.[1] as PreloadApi

    await expect(api.terminalPresence.get()).resolves.toEqual({
      host: null,
      terminals: [TERMINAL]
    })
    expect(invoke).toHaveBeenCalledWith('terminalPresence:get')

    const received: TerminalPresenceLocalTerminal[] = []
    const unsubscribe = api.terminalPresence.onChanged((terminal) => received.push(terminal))
    const listener = on.mock.calls.find(([channel]) => channel === 'terminalPresence:changed')?.[1]
    listener?.({}, TERMINAL)
    expect(received).toEqual([TERMINAL])

    // Negative control for the teardown the hub relies on: a listener that outlives the effect would
    // keep writing into the pane lane after the renderer stopped reading it.
    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('terminalPresence:changed', listener)
  })
})
