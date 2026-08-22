import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/orca-test-userdata')
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  powerMonitor: {
    on: vi.fn()
  }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 12345
  })
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import { registerPtyHandlers } from './pty'
import {
  HOST_ATTACHMENT_KEY,
  terminalPresenceRegistry
} from '../runtime/terminal-presence-registry'
import {
  TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
  buildTerminalPresenceActivityRows
} from '../runtime/terminal-presence-activity-rows'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const PTY_ID = 'pty-host-1'
const PEER_CONNECTION = 'conn-peer-1'
const PEER_GRANT = 'device-runtime-9'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false }
}
const mainWindowIpcEvent = { sender: mainWindow.webContents }

function setup(
  driverKind: 'idle' | 'mobile' = 'idle',
  runtimeOverrides: Record<string, unknown> = {}
): void {
  handlers.clear()
  handleMock.mockReset()
  onMock.mockReset()
  const register = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    handlers.set(channel, handler)
  }
  handleMock.mockImplementation(register)
  onMock.mockImplementation(register)
  const runtime = {
    getDriver: () => ({ kind: driverKind }),
    setPtyController: vi.fn(),
    handleMobileUnsubscribe: vi.fn(),
    ...runtimeOverrides
  } as unknown as OrcaRuntimeService
  registerPtyHandlers(mainWindow as never, runtime)
}

function hostRows(now = Date.now()) {
  return buildTerminalPresenceActivityRows({
    registry: terminalPresenceRegistry,
    ptyId: PTY_ID,
    now
  })
}

function typingByKind(): Record<string, boolean> {
  return Object.fromEntries(hostRows().map((row) => [row.kind, row.typing]))
}

function writeFromMainWindow(data = 'x'): void {
  ;(handlers.get('pty:write') as (event: unknown, args: unknown) => void)(mainWindowIpcEvent, {
    id: PTY_ID,
    data
  })
}

function writeAcceptedFromMainWindow(data = 'x'): Promise<boolean> | boolean {
  return (
    handlers.get('pty:writeAccepted') as (
      event: unknown,
      args: unknown
    ) => Promise<boolean> | boolean
  )(mainWindowIpcEvent, { id: PTY_ID, data })
}

function claimViewportFromMainWindow(): void {
  ;(handlers.get('pty:claimViewport') as (event: unknown, args: unknown) => void)(
    mainWindowIpcEvent,
    { id: PTY_ID, cols: 120, rows: 40 }
  )
}

// Why deferred: the claim tail is what makes the write asynchronous, so a stamp that rides it would
// still pass an assertion taken after the promise settles. Holding it open pins the stamp to the
// keystroke itself.
function setupWithPendingViewportClaim(): (claimed: boolean) => void {
  let settleClaim: (claimed: boolean) => void = () => {}
  const claim = new Promise<boolean>((resolve) => {
    settleClaim = resolve
  })
  setup('idle', { claimRemoteDesktopHost: vi.fn().mockReturnValue(claim) })
  claimViewportFromMainWindow()
  return (claimed: boolean) => {
    settleClaim(claimed)
  }
}

beforeEach(() => {
  terminalPresenceRegistry.reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('host presence stamp (site c)', () => {
  it('stamps the reserved host key on a write the provider check rejects', () => {
    setup()
    // Why: no ownership is registered for this PTY, so writePtyInput returns false at the provider
    // check — a stamp placed after the guards would report PTY effect instead of human intent.
    writeFromMainWindow()

    const attachment = terminalPresenceRegistry.attachmentsOf(PTY_ID).get(HOST_ATTACHMENT_KEY)
    expect(attachment?.connectionId).toBeNull()
    expect(attachment?.lastInteractiveInputAt).toBeGreaterThan(0)
    // Why the interactive map and not grantWrites: only the interactive stamp reads as *typing* and
    // only it can arm a hold, which is the entire point of Q4's host row.
    expect(terminalPresenceRegistry.grantWritesOf(PTY_ID).size).toBe(0)
    expect(hostRows()).toEqual([
      expect.objectContaining({ participantId: 'host', kind: 'host', typing: true, writing: false })
    ])
  })

  it('stamps on a write the mobile-driver guard rejects', () => {
    setup('mobile')
    writeFromMainWindow()

    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])
  })

  it('stamps on writePtyInputAccepted, which rejects even earlier on ownership', async () => {
    setup()

    await writeAcceptedFromMainWindow('y')

    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])
  })

  it('stamps a write a lost viewport claim drops before the writer ever runs', async () => {
    const settleClaim = setupWithPendingViewportClaim()

    writeFromMainWindow()
    // Why asserted while the claim is still in flight: the write itself is queued behind the tail, so a
    // stamp inside the writer would read false here — the window where a remote desktop viewer owns the
    // width and the local human is reclaiming it is exactly when a peer must see the host typing.
    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])

    settleClaim(false)
    await Promise.resolve()
    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])
  })

  it('stamps an accepted write the lost claim answers false', async () => {
    const settleClaim = setupWithPendingViewportClaim()

    const accepted = writeAcceptedFromMainWindow()
    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])

    settleClaim(false)
    // Why the return value is asserted: it proves the keystroke really was dropped, so the row above is
    // reporting intent rather than a write that quietly landed anyway.
    await expect(accepted).resolves.toBe(false)
    expect(hostRows()).toEqual([expect.objectContaining({ kind: 'host', typing: true })])
  })

  it('ignores an IPC write whose sender is not the main window', () => {
    setup()
    ;(handlers.get('pty:write') as (event: unknown, args: unknown) => void)(
      { sender: { id: 'other-frame' } },
      { id: PTY_ID, data: 'x' }
    )

    expect(terminalPresenceRegistry.attachmentsOf(PTY_ID).size).toBe(0)
    expect(hostRows()).toEqual([])
  })

  it('expires with a remote stream stamp on one clock', () => {
    vi.useFakeTimers()
    setup()
    terminalPresenceRegistry.registerConnection({
      connectionId: PEER_CONNECTION,
      pairedDeviceId: PEER_GRANT,
      label: 'Ben laptop',
      kind: 'runtime'
    })
    terminalPresenceRegistry.attach(PTY_ID, `multiplex:${PEER_CONNECTION}:1`, PEER_CONNECTION)

    // Why one clock: the host writers stamp lastInputAtByPty with performance.now(), so a presence stamp
    // that reused that domain would read as permanently idle here while every other assertion passed.
    terminalPresenceRegistry.recordInteractiveInput(PTY_ID, `multiplex:${PEER_CONNECTION}:1`)
    writeFromMainWindow()
    expect(typingByKind()).toEqual({ host: true, runtime: true })

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    expect(typingByKind()).toEqual({ host: false, runtime: false })
  })
})
