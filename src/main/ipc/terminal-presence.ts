// Why an IPC lane and not a wire surface (gap 9): the host's own renderer receives no presence today —
// it subscribes to runtime.clientEvents per REMOTE environment, and a local PTY has no multiplex stream
// for the per-PTY event to ride. So the host's human publishes presence to every peer and sees none.
//
// Why it is NOT sourced from runtime.onClientEvent: that bus (W8) is membership-only, carries no
// typing/writing flag, and lists attached terminals as handles rather than the ptyId the renderer keys
// panes by. Sourced from there the host's chip could never flip. This subscribes to the presence
// registry's per-ptyId coalescer instead — the same pre-serialization feed W4 serializes onto a stream.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type {
  TerminalPresenceLocalHost,
  TerminalPresenceLocalSnapshot,
  TerminalPresenceLocalTerminal
} from '../../shared/terminal-presence-ipc'
import {
  buildTerminalPresenceActivityRows,
  type TerminalPresenceActivityRow
} from '../runtime/terminal-presence-activity-rows'
import {
  terminalPresenceChangeNotifier,
  type TerminalPresenceChangeNotifier
} from '../runtime/terminal-presence-change-notifier'
import {
  HOST_ATTACHMENT_KEY,
  terminalPresenceRegistry,
  type TerminalPresenceRegistry
} from '../runtime/terminal-presence-registry'
import {
  HOST_PARTICIPANT_ID,
  resolveHostPresenceLabel
} from '../runtime/terminal-presence-snapshot'

export const TERMINAL_PRESENCE_GET_CHANNEL = 'terminalPresence:get'
export const TERMINAL_PRESENCE_CHANGED_CHANNEL = 'terminalPresence:changed'

export type TerminalPresenceIpcOptions = {
  // Why required: a roster row shows a handle, and minting one here would let a read-only surface
  // mutate the handle table. A PTY nobody addressed by handle publishes null.
  resolveTerminalHandle: (ptyId: string) => string | null
  registry?: TerminalPresenceRegistry
  notifier?: TerminalPresenceChangeNotifier
}

// Why a token: macOS keeps the process alive with no window, so a later window re-registers these
// channels; the older window's 'closed' must not remove the newer registration's handler.
let activeRegistrationToken = 0

export function registerTerminalPresenceHandlers(
  mainWindow: BrowserWindow,
  options: TerminalPresenceIpcOptions
): () => void {
  const token = ++activeRegistrationToken
  const registry = options.registry ?? terminalPresenceRegistry
  const notifier = options.notifier ?? terminalPresenceChangeNotifier
  const watchedPtyIds = new Map<string, () => void>()
  const publishedPtyIds = new Set<string>()
  let disposed = false

  const hostRow = (): TerminalPresenceLocalHost => ({
    participantId: HOST_PARTICIPANT_ID,
    label: resolveHostPresenceLabel(),
    kind: 'host',
    self: true
  })

  const rowsFor = (ptyId: string): TerminalPresenceActivityRow[] =>
    buildTerminalPresenceActivityRows({
      registry,
      ptyId,
      now: registry.now(),
      selfParticipantId: HOST_PARTICIPANT_ID
    })

  const toTerminal = (
    ptyId: string,
    participants: TerminalPresenceActivityRow[]
  ): TerminalPresenceLocalTerminal => ({
    ptyId,
    handle: options.resolveTerminalHandle(ptyId),
    participants
  })

  // Why the reserved host key is not a peer: the local human is the reader of this channel, so a PTY
  // holding only that key has nobody to announce.
  const hasPeerPresence = (ptyId: string): boolean => {
    for (const key of registry.attachmentsOf(ptyId).keys()) {
      if (key !== HOST_ATTACHMENT_KEY) {
        return true
      }
    }
    return registry.grantWritesOf(ptyId).size > 0
  }

  const dropWatch = (ptyId: string): void => {
    watchedPtyIds.get(ptyId)?.()
    watchedPtyIds.delete(ptyId)
  }

  const send = (terminal: TerminalPresenceLocalTerminal): void => {
    if (disposed || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
      return
    }
    mainWindow.webContents.send(TERMINAL_PRESENCE_CHANGED_CHANNEL, terminal)
  }

  const publish = (ptyId: string): void => {
    const participants = rowsFor(ptyId)
    const peers = participants.some((row) => row.participantId !== HOST_PARTICIPANT_ID)
    // Why both halves of the guard: a solo desktop stamps the reserved host key on every keystroke, so
    // "no peers" must stay silent — but the one payload that CLEARS a chip is also a no-peer payload.
    if (!peers && !publishedPtyIds.has(ptyId)) {
      dropWatch(ptyId)
      return
    }
    if (peers) {
      publishedPtyIds.add(ptyId)
    } else {
      publishedPtyIds.delete(ptyId)
      dropWatch(ptyId)
    }
    send(toTerminal(ptyId, participants))
  }

  const ensureWatch = (ptyId: string): void => {
    if (watchedPtyIds.has(ptyId)) {
      return
    }
    watchedPtyIds.set(
      ptyId,
      notifier.subscribe(ptyId, () => publish(ptyId))
    )
    // Why immediately and not through the coalescer: the notifier schedules only for PTYs it already
    // watches, so the change that created this watch reached nobody — and that change is a peer
    // arriving, the one event a chip should not wait a window for.
    publish(ptyId)
  }

  const unsubscribeRegistry = registry.onChange((ptyId) => {
    // Why gated on peers rather than watching every PTY: a watch arms a coalescer and a TTL timer, and
    // the host's own keystrokes stamp every local PTY. A solo desktop must pay nothing.
    if (hasPeerPresence(ptyId)) {
      ensureWatch(ptyId)
    }
  })

  const snapshot = (): TerminalPresenceLocalSnapshot => {
    // Why the watch set too: attachments name every PTY somebody is streaming, and a grant-write-only
    // writer (the phone's chat composer) has no attachment to enumerate.
    const ptyIds = new Set([...registry.attachmentsSnapshot().keys(), ...watchedPtyIds.keys()])
    const terminals: TerminalPresenceLocalTerminal[] = []
    for (const ptyId of ptyIds) {
      const participants = rowsFor(ptyId)
      if (participants.length > 0) {
        terminals.push(toTerminal(ptyId, participants))
      }
    }
    return { host: hostRow(), terminals }
  }

  const isMainWindowSender = (event: IpcMainInvokeEvent): boolean =>
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    event.sender === mainWindow.webContents

  ipcMain.removeHandler(TERMINAL_PRESENCE_GET_CHANNEL)
  ipcMain.handle(TERMINAL_PRESENCE_GET_CHANNEL, (event): TerminalPresenceLocalSnapshot => {
    // Why sender-gated: presence names the humans on this machine, and only the desktop's own main
    // frame is the reader this lane exists for. Anything else gets the empty answer, not a roster.
    if (!isMainWindowSender(event)) {
      return { host: hostRow(), terminals: [] }
    }
    return snapshot()
  })

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    unsubscribeRegistry()
    for (const ptyId of Array.from(watchedPtyIds.keys())) {
      dropWatch(ptyId)
    }
    publishedPtyIds.clear()
    if (activeRegistrationToken === token) {
      ipcMain.removeHandler(TERMINAL_PRESENCE_GET_CHANNEL)
    }
  }

  mainWindow.on('closed', dispose)
  return dispose
}
