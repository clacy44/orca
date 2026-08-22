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
import { TERMINAL_PRESENCE_ACTIVITY_TTL_MS } from '../runtime/terminal-presence-activity-rows'
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

/** The full arm/publish/clear/drop cycle as a W4 stream listener on the same notifier key would see it,
 *  as offsets from the start so two runs at different clock positions stay comparable. The host types
 *  before the peer leaves on purpose: that stamp outlives the lane's dropWatch, so the last entry here
 *  is a falling edge the lane could only deliver by not disturbing the key it shares. */
function driveW4StreamListener(): number[] {
  const startedAt = Date.now()
  const emits: number[] = []
  const unsubscribe = notifier.subscribe(PTY_ID, () => emits.push(Date.now() - startedAt))
  attachPeer()
  vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
  registry.recordInteractiveInput(PTY_ID, PEER_KEY)
  vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
  registry.recordHostInteractiveInput(PTY_ID)
  registry.detach(PTY_ID, PEER_KEY)
  vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)
  unsubscribe()
  return emits
}

/** Re-registers the lane behind a notifier that records what it subscribed and how many of those
 *  subscriptions are still live, because a subscription the lane never releases is otherwise silent. */
function trackNotifierSubscriptions(): {
  subscribed: string[]
  liveCount: (ptyId: string) => number
} {
  const subscribed: string[] = []
  const live = new Map<string, number>()
  dispose()
  const inner = notifier
  notifier = {
    subscribe: (ptyId, listener) => {
      subscribed.push(ptyId)
      live.set(ptyId, (live.get(ptyId) ?? 0) + 1)
      const unsubscribe = inner.subscribe(ptyId, listener)
      return () => {
        live.set(ptyId, (live.get(ptyId) ?? 0) - 1)
        unsubscribe()
      }
    },
    dispose: () => inner.dispose()
  }
  register()
  return { subscribed, liveCount: (ptyId) => live.get(ptyId) ?? 0 }
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

  it('clears a chip for a peer that was already attached when the handlers registered', () => {
    // Reachable on headless `orca serve` then desktop activation, and on macOS close-window/reopen.
    // Hydration is the only way this peer reaches the renderer, so it must arm the watch too: the
    // payload that retracts the chip is a peerless one, and the change gate never arms one for those.
    dispose()
    attachPeer()
    register()
    stub.sends.length = 0
    expect(invokeGet(stub.sender).terminals).toHaveLength(1)

    registry.detach(PTY_ID, PEER_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(stub.sends).toHaveLength(1)
    expect(stub.sends[0]?.ptyId).toBe(PTY_ID)
    expect(peerRow(stub.sends[0]!)).toBeUndefined()
  })

  it('hydrates nothing for a solo desktop that has typed in several PTYs', () => {
    registry.recordHostInteractiveInput(PTY_ID)
    registry.recordHostInteractiveInput('pty-local-2')

    // Negative control for the suppression rule: the host row rides `snapshot.host`, so a host-only
    // terminal here is a row the renderer would seed and no later push could ever clear.
    expect(invokeGet(stub.sender).terminals).toEqual([])
  })

  it('stops re-arming a watch once a peer grant write has expired', () => {
    const { subscribed } = trackNotifierSubscriptions()
    registry.registerConnection({
      connectionId: 'conn-ben',
      pairedDeviceId: 'grant-ben',
      label: "Ben's phone",
      kind: 'mobile'
    })
    registry.recordGrantWrite(PTY_ID, 'grant-ben')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)
    registry.releaseConnection('conn-ben')
    subscribed.length = 0
    stub.sends.length = 0

    registry.recordHostInteractiveInput(PTY_ID)
    registry.recordHostInteractiveInput(PTY_ID)
    registry.recordHostInteractiveInput(PTY_ID)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS * 4)

    // Nothing sweeps grant writes on disconnect, so the raw map still names Ben for this PTY's whole
    // life. Reading the projected rows instead is what keeps a solo desktop paying nothing.
    expect(subscribed).toEqual([])
    expect(stub.sends).toEqual([])
  })

  it('releases its notifier subscription once the last peer leaves', () => {
    const notifierSubscriptions = trackNotifierSubscriptions()
    attachPeer()
    expect(notifierSubscriptions.liveCount(PTY_ID)).toBe(1)

    registry.detach(PTY_ID, PEER_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // Why asserted on the notifier and not on the send spy: a leaked subscription is invisible there —
    // publish() bails on a peerless PTY — but it keeps the notifier's coalescer scheduling and its TTL
    // timer re-arming on every host keystroke for the rest of the PTY's life. A solo desktop that once
    // had a guest must go back to paying nothing.
    expect(notifierSubscriptions.liveCount(PTY_ID)).toBe(0)
  })

  it('leaves a W4 stream listener on the same PTY exactly as it found it', () => {
    const withLane = driveW4StreamListener()

    // Companion run with no registerTerminalPresenceHandlers at all: a renderer that never registers
    // the channel must leave publication to peers byte-identical.
    dispose()
    notifier.dispose()
    registry = new TerminalPresenceRegistry()
    notifier = createTerminalPresenceChangeNotifier({ registry })
    const withoutLane = driveW4StreamListener()

    // Non-vacuity: three coalesced emits plus the falling edge that outlives the lane's own teardown.
    expect(withLane).toHaveLength(4)
    expect(withoutLane).toEqual(withLane)
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
