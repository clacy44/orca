import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type {
  TerminalPresenceLocalSnapshot,
  TerminalPresenceLocalTerminal
} from '../../shared/terminal-presence-ipc'
import { TerminalPresenceRegistry } from '../runtime/terminal-presence-registry'
import {
  TERMINAL_PRESENCE_COALESCE_WINDOW_MS,
  createTerminalPresenceChangeNotifier,
  type TerminalPresenceChangeNotifier
} from '../runtime/terminal-presence-change-notifier'
import {
  TERMINAL_PRESENCE_CHANGED_CHANNEL,
  TERMINAL_PRESENCE_GET_CHANNEL,
  registerTerminalPresenceHandlers
} from './terminal-presence'

const PTY_ID = 'pty-local-1'
const PTY_HANDLE = 'terminal-7'
const PEER_KEY = 'terminal-multiplex:conn-ana'

type WindowStub = {
  window: BrowserWindow
  sender: object
  sends: TerminalPresenceLocalTerminal[]
  close: () => void
}

function makeWindow(): WindowStub {
  const sends: TerminalPresenceLocalTerminal[] = []
  const closedListeners: (() => void)[] = []
  let destroyed = false
  const webContents = {
    isDestroyed: (): boolean => destroyed,
    send: (channel: string, payload: TerminalPresenceLocalTerminal): void => {
      expect(channel).toBe(TERMINAL_PRESENCE_CHANGED_CHANNEL)
      sends.push(payload)
    }
  }
  const window = {
    isDestroyed: (): boolean => destroyed,
    webContents,
    on: (event: string, listener: () => void): void => {
      if (event === 'closed') {
        closedListeners.push(listener)
      }
    }
  } as unknown as BrowserWindow
  return {
    window,
    sender: webContents,
    sends,
    close: (): void => {
      destroyed = true
      closedListeners.forEach((listener) => listener())
    }
  }
}

let registry: TerminalPresenceRegistry
let notifier: TerminalPresenceChangeNotifier
let stub: WindowStub
let dispose: () => void

function register(): void {
  dispose = registerTerminalPresenceHandlers(stub.window, {
    resolveTerminalHandle: (ptyId) => (ptyId === PTY_ID ? PTY_HANDLE : null),
    registry,
    notifier
  })
}

function invokeGet(sender: object): TerminalPresenceLocalSnapshot {
  const entry = handleMock.mock.calls.findLast(
    (call) => call[0] === TERMINAL_PRESENCE_GET_CHANNEL
  ) as [string, (event: IpcMainInvokeEvent) => TerminalPresenceLocalSnapshot] | undefined
  if (!entry) {
    throw new Error('terminalPresence:get was never registered')
  }
  return entry[1]({ sender } as unknown as IpcMainInvokeEvent)
}

function attachPeer(): void {
  registry.registerConnection({
    connectionId: 'conn-ana',
    pairedDeviceId: 'grant-ana',
    label: 'Ana laptop',
    kind: 'runtime'
  })
  registry.attach(PTY_ID, PEER_KEY, 'conn-ana')
}

function peerRow(payload: TerminalPresenceLocalTerminal) {
  return payload.participants.find((row) => row.participantId !== 'host')
}

function hostRow(payload: TerminalPresenceLocalTerminal) {
  return payload.participants.find((row) => row.participantId === 'host')
}

beforeEach(() => {
  vi.useFakeTimers()
  handleMock.mockClear()
  removeHandlerMock.mockClear()
  registry = new TerminalPresenceRegistry()
  notifier = createTerminalPresenceChangeNotifier({ registry })
  stub = makeWindow()
  register()
})

afterEach(() => {
  dispose()
  notifier.dispose()
  vi.useRealTimers()
})

describe('local terminal presence IPC lane', () => {
  it('publishes a peer attached to a local PTY, with the host row resolved as self', () => {
    attachPeer()
    registry.recordHostInteractiveInput(PTY_ID)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    const latest = stub.sends.at(-1)
    expect(latest?.ptyId).toBe(PTY_ID)
    expect(peerRow(latest!)).toMatchObject({ label: 'Ana laptop', kind: 'runtime', self: false })
    // Why: the reader of this channel IS the host participant, so `self` is resolved host-side and the
    // pane chip filters the reader out with no renderer-side identity.
    expect(hostRow(latest!)).toMatchObject({ kind: 'host', self: true })
  })

  it('carries ptyId beside the handle so the pane lane needs no reverse lookup', () => {
    attachPeer()

    // A payload carrying only `handle` cannot be joined to a pane: the renderer keys panes by ptyId.
    expect(stub.sends.at(-1)).toMatchObject({ ptyId: PTY_ID, handle: PTY_HANDLE })
  })

  it('emits no IPC traffic at all while the PTY has no participants', () => {
    registry.recordHostInteractiveInput(PTY_ID)
    registry.recordHostInteractiveInput('pty-local-2')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS * 4)

    expect(stub.sends).toEqual([])
  })

  it('flips a peer to typing within one coalescer window', () => {
    attachPeer()
    const beforeTyping = stub.sends.length
    expect(peerRow(stub.sends.at(-1)!)?.typing).toBe(false)

    registry.recordInteractiveInput(PTY_ID, PEER_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // Why this is the assertion that makes the lane non-vacuous: a lane sourced from
    // runtime.onClientEvent (W8) is membership-only and carries no typing flag at all, so it would
    // pass every other case here and fail exactly this one.
    expect(stub.sends.length).toBeGreaterThan(beforeTyping)
    expect(peerRow(stub.sends.at(-1)!)?.typing).toBe(true)
  })

  it('flips the host row to typing within one window while a peer is attached', () => {
    attachPeer()
    const beforeTyping = stub.sends.length

    registry.recordHostInteractiveInput(PTY_ID)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // Proves site (c)'s reserved-key stamp reaches this lane and not only the wire surfaces.
    expect(stub.sends.length).toBeGreaterThan(beforeTyping)
    expect(hostRow(stub.sends.at(-1)!)).toMatchObject({ typing: true, self: true })
  })

  it('sends one clearing payload when the last peer detaches, then goes quiet again', () => {
    attachPeer()
    registry.detach(PTY_ID, PEER_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(peerRow(stub.sends.at(-1)!)).toBeUndefined()
    const afterClear = stub.sends.length
    registry.recordHostInteractiveInput(PTY_ID)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS * 4)

    expect(stub.sends.length).toBe(afterClear)
  })

  it('hydrates the full local roster, including the always-present host row', () => {
    attachPeer()

    const snapshot = invokeGet(stub.sender)
    expect(snapshot.host).toMatchObject({ participantId: 'host', kind: 'host', self: true })
    expect(snapshot.host.label.length).toBeGreaterThan(0)
    expect(snapshot.terminals).toHaveLength(1)
    expect(snapshot.terminals[0]).toMatchObject({ ptyId: PTY_ID, handle: PTY_HANDLE })
  })

  it('answers a sender that is not the main window with an empty roster', () => {
    attachPeer()

    // Negative control for the sender gate: presence names the humans on this machine.
    expect(invokeGet({ id: 'someone-else' }).terminals).toEqual([])
  })

  it('stops publishing and removes its handler once the window closes', () => {
    attachPeer()
    const beforeClose = stub.sends.length

    stub.close()
    registry.recordInteractiveInput(PTY_ID, PEER_KEY)
    registry.attach('pty-local-2', PEER_KEY, 'conn-ana')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS * 4)

    expect(stub.sends.length).toBe(beforeClose)
    expect(removeHandlerMock).toHaveBeenCalledWith(TERMINAL_PRESENCE_GET_CHANNEL)
  })
})
