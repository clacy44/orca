/**
 * S10-21g r162: after `systemctl restart orca-serve`, the survived chair pane's pty and
 * daemon session were fine, but the desktop viewer painted blank until an app relaunch.
 *
 * Root cause (R3): the daemon-survived arm adopts the pty's ORCA_TERMINAL_HANDLE only into
 * `handleByPtyId` (registerPreAllocatedHandleForPty); on `orca serve` the leaf graph is empty
 * (no renderer), so the leaf-adoption loop is a no-op and `this.handles` never gets a record —
 * `resolveLiveLeafForHandle`/`waitForLeafPtyId` see nothing, and a real `terminal.multiplex`
 * Subscribe times out into `no_connected_pty`.
 *
 * This harness runs ONLY the survived arm's own runtime calls — `adoptControllerTerminalHandle`
 * (private; the sweep's own adoption path) + `ensureProviderAttachForSurvivedPty` (public) —
 * headless (no leaves, no renderer serializer), then drives a real terminal.multiplex Subscribe
 * for the adopted handle with a desktop client.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import type { PtyProcessInfo } from '../../providers/pty-process-info'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@survived-r162`
const TERMINAL_HANDLE = 'term_survived_r162'
const INCARNATION_ID = 'incarnation-survived-r162'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; incarnationId?: string }
  ) => unknown
  adoptControllerTerminalHandle: (
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options?: { exactRestoredSurface?: boolean }
  ) => void
  handleByPtyId: Map<string, string>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

type ControllerStub = {
  write: () => boolean
  kill: () => boolean
  attach: (ptyId: string) => Promise<boolean>
  serializeProviderBuffer: (ptyId: string) => Promise<{
    data: string
    cols: number
    rows: number
    seq: number
    source: 'headless'
  } | null>
}

/** Models the restore sweep's daemon-survived arm entirely at the runtime layer: a
 *  controller-inventory identity match (term_X + matching incarnation) already proved this
 *  pty survived, and the sweep is attaching it — no leaf, no window, no renderer serializer. */
function setupSurvivedDaemonPty(): {
  runtime: OrcaRuntimeService
  releaseAttach: (result: boolean) => void
  attachCalls: string[]
} {
  const runtime = new OrcaRuntimeService()
  let releaseAttach!: (result: boolean) => void
  const attachPromise = new Promise<boolean>((resolve) => {
    releaseAttach = resolve
  })
  const attachCalls: string[] = []
  const controller: ControllerStub = {
    write: () => true,
    kill: () => true,
    attach: (ptyId: string) => {
      attachCalls.push(ptyId)
      return attachPromise
    },
    serializeProviderBuffer: async () => ({
      data: 'provider frozen screen\r\n',
      cols: 80,
      rows: 24,
      seq: 0,
      source: 'headless'
    })
  }
  runtime.setPtyController(controller as never)
  internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, {
    connected: true,
    incarnationId: INCARNATION_ID
  })
  internals(runtime).adoptControllerTerminalHandle(PTY_ID, TERMINAL_HANDLE, INCARNATION_ID, {
    exactRestoredSurface: true
  })
  return { runtime, releaseAttach, attachCalls }
}

function startMultiplex(runtime: OrcaRuntimeService): {
  messages: { result?: { type?: string; streamId?: number | null; message?: string } }[]
  binaryFrames: Uint8Array<ArrayBufferLike>[]
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>
} {
  const messages: { result?: { type?: string; streamId?: number | null; message?: string } }[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  void dispatcher.dispatchStreaming(
    request,
    (msg) => {
      messages.push(JSON.parse(msg))
    },
    {
      connectionId: 'conn-desktop',
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
        binaryFrames.push(bytes)
        return true
      },
      registerBinaryStreamHandler: (
        streamId: number,
        handler: (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      ) => {
        handlers.set(streamId, handler)
        return () => {
          if (handlers.get(streamId) === handler) {
            handlers.delete(streamId)
          }
        }
      }
    }
  )
  return { messages, binaryFrames, handlers }
}

function sendSubscribe(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>,
  terminal: string
): void {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 1,
          terminal,
          client: { id: 'client-desktop', type: 'desktop' }
        })
      })
    )!
  )
}

describe('R162 daemon-survived pty subscribe (headless, no leaves)', () => {
  it('R3: does not end a desktop multiplex subscribe with no_connected_pty after the survived arm attaches', async () => {
    const { runtime, releaseAttach } = setupSurvivedDaemonPty()

    const attachDone = runtime.ensureProviderAttachForSurvivedPty(PTY_ID)
    releaseAttach(true)
    await attachDone

    const { messages, handlers } = startMultiplex(runtime)
    await vi.waitFor(() => expect(handlers.has(0)).toBe(true))

    sendSubscribe(handlers, TERMINAL_HANDLE)

    await vi.waitFor(
      () =>
        expect(
          messages.some((m) => m.result?.type === 'subscribed' || m.result?.type === 'error')
        ).toBe(true),
      { timeout: 12_000 }
    )

    expect(
      messages.some((m) => m.result?.type === 'error' && m.result?.message === 'no_connected_pty')
    ).toBe(false)
    expect(messages.some((m) => m.result?.type === 'subscribed')).toBe(true)
  }, 15_000)

  it('R1: the first snapshot after the survived arm attaches carries the provider buffer, not the pre-attach fragment', async () => {
    const { runtime, releaseAttach } = setupSurvivedDaemonPty()

    const attachDone = runtime.ensureProviderAttachForSurvivedPty(PTY_ID)
    // Why: a live chunk can land mid-attach, before the daemon confirms.
    runtime.onPtyData(PTY_ID, 'x', Date.now())
    releaseAttach(true)
    await attachDone

    const { messages, binaryFrames, handlers } = startMultiplex(runtime)
    await vi.waitFor(() => expect(handlers.has(0)).toBe(true))

    sendSubscribe(handlers, TERMINAL_HANDLE)

    await vi.waitFor(
      () => expect(messages.some((m) => m.result?.type === 'subscribed')).toBe(true),
      { timeout: 12_000 }
    )

    const snapshotText = binaryFrames
      .map(decodeTerminalStreamFrame)
      .filter((f) => f?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((f) => decodeTerminalStreamText(f!.payload))
      .join('')
    expect(snapshotText).toContain('provider frozen screen')
    expect(snapshotText).not.toBe('x')
  }, 15_000)
})

describe('R3 placement: adopt-first (production) ordering creates the leafless handle record', () => {
  it('creates the handle record when adoptControllerTerminalHandle runs BEFORE recordPtyWorktree, with no second handle minted', () => {
    const runtime = new OrcaRuntimeService()
    const rt = internals(runtime)

    // Production ordering: the controller-inventory sweep adopts the survived handle first —
    // at this point there is no ptysById record yet.
    rt.adoptControllerTerminalHandle(PTY_ID, TERMINAL_HANDLE, INCARNATION_ID, {
      exactRestoredSurface: true
    })
    expect(runtime.resolveLiveLeafForHandle(TERMINAL_HANDLE)).toBeNull()

    // Then the pty gets recorded, as recordPtyWorktree's NEW-record branch does on this path.
    rt.recordPtyWorktree(PTY_ID, WORKTREE_ID, {
      connected: true,
      incarnationId: INCARNATION_ID
    })

    expect(runtime.resolveLiveLeafForHandle(TERMINAL_HANDLE)).toEqual({ ptyId: PTY_ID })
    expect(rt.handleByPtyId.get(PTY_ID)).toBe(TERMINAL_HANDLE)
  })

  it('a single takeControllerInventoryForSweep pass creates the handle record for a survived session (adopt-first, real inventory sync)', async () => {
    const runtime = new OrcaRuntimeService()
    const rt = internals(runtime)
    const session: PtyProcessInfo = {
      id: PTY_ID,
      cwd: '/tmp/wt',
      title: 'survived',
      incarnationId: INCARNATION_ID as unknown as PtyProcessInfo['incarnationId'],
      terminalHandle: TERMINAL_HANDLE
    }
    const controller: ControllerStub & { listProcesses: () => Promise<PtyProcessInfo[]> } = {
      write: () => true,
      kill: () => true,
      attach: async () => true,
      serializeProviderBuffer: async () => null,
      listProcesses: async () => [session]
    }
    runtime.setPtyController(controller as never)

    const inventory = await runtime.takeControllerInventoryForSweep()

    expect(inventory).not.toBeNull()
    expect(runtime.resolveLiveLeafForHandle(TERMINAL_HANDLE)).toEqual({ ptyId: PTY_ID })
    expect(rt.handleByPtyId.get(PTY_ID)).toBe(TERMINAL_HANDLE)
  })

  it('the existing record-first ordering (recordPtyWorktree then adopt) still creates the handle record', () => {
    const runtime = new OrcaRuntimeService()
    const rt = internals(runtime)

    rt.recordPtyWorktree(PTY_ID, WORKTREE_ID, {
      connected: true,
      incarnationId: INCARNATION_ID
    })
    rt.adoptControllerTerminalHandle(PTY_ID, TERMINAL_HANDLE, INCARNATION_ID, {
      exactRestoredSurface: true
    })

    expect(runtime.resolveLiveLeafForHandle(TERMINAL_HANDLE)).toEqual({ ptyId: PTY_ID })
  })
})
