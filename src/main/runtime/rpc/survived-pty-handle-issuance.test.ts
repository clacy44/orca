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

// R177: a fresh spawn's pty id, distinct from the survived-pty fixtures above.
const FRESH_PTY_ID = `${WORKTREE_ID}@@fresh-spawn-r177`
const FRESH_TAB_ID = 'tab-fresh-r177'
const FRESH_LEAF_ID = '11111111-1111-4111-8111-111111111111'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; incarnationId?: string }
  ) => unknown
  registerPty: (
    ptyId: string,
    worktreeId: string,
    connectionId: string | null,
    binding?: { tabId: string; leafId: string }
  ) => void
  adoptControllerTerminalHandle: (
    ptyId: string,
    handle: string | undefined,
    incarnationId?: string,
    options?: { exactRestoredSurface?: boolean }
  ) => void
  handleByPtyId: Map<string, string>
  handles: Map<string, unknown>
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
  // R177 SCENARIO_CORRECTION: this describe block used to open with a unit-level case that
  // drove `adoptControllerTerminalHandle` then `recordPtyWorktree` DIRECTLY and asserted a
  // handle record appeared after `recordPtyWorktree` alone. R177 moves the adopt-first write
  // from `recordPtyWorktree`'s own NEW-record branch into the controller-inventory sync
  // caller (`refreshPtyWorktreeRecordsWithControllerInventory`), so `recordPtyWorktree` no
  // longer writes a leafless record under ANY ordering of direct unit calls — only the real
  // inventory-sync path does. That makes the deleted case's assertion false by construction
  // (not a bug: driving the two private methods by hand no longer exercises the write site).
  // It is also fully redundant with the case below, which drives the real
  // `takeControllerInventoryForSweep` -> `refreshPtyWorktreeRecordsWithControllerInventory`
  // pipeline and proves the same adopt-first-creates-the-record property against the
  // production call path instead of a hand-rolled one. Deleted rather than reshaped.
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

describe('R177: an ordinary fresh spawn must NOT get a leafless handle record', () => {
  it('registerPty (no controller inventory, no leaf) leaves this.handles without a record for the spawned pty', () => {
    const runtime = new OrcaRuntimeService()
    const rt = internals(runtime)

    // Mirrors src/main/ipc/pty.ts ~:2684: the env builder pre-allocates a handle by ptyId
    // before the process exists, purely so the agent can self-identify via
    // ORCA_TERMINAL_HANDLE — this must NOT create a `this.handles` record.
    const handle = runtime.preAllocateHandleForPty(FRESH_PTY_ID)

    // Then the ORDINARY registerPty path runs (chair restore / createTerminal / desktop
    // spawn) — connected: true, no controller inventory, no leaf registered.
    rt.registerPty(FRESH_PTY_ID, WORKTREE_ID, null, {
      tabId: FRESH_TAB_ID,
      leafId: FRESH_LEAF_ID
    })

    expect(rt.handleByPtyId.get(FRESH_PTY_ID)).toBe(handle)
    // At base (8e7b485669) recordPtyWorktree's NEW-record branch called
    // ensureLeaflessHandleRecord unconditionally, so this record existed for every ordinary
    // spawn — that is the R177 defect: a `pty:` record makes getTerminalHandleForPaneKey
    // resolve immediately, so writeHostNoticeToPane's queued "Launch admission notice" can
    // type into a pane whose agent has not reached its startup prompt yet.
    expect(rt.handles.has(handle)).toBe(false)
    expect(runtime.resolveLiveLeafForHandle(handle)).toBeNull()

    // Deviation from the brief's literal predicate (recorded per this seat's standing
    // instruction to follow the tree over the brief when they disagree): the brief also asks
    // to assert `getTerminalHandleForPaneKey(paneKey)` is null/undefined here, calling it "the
    // predicate writeHostNoticeToPane gates on". Read at src/main/runtime/orca-runtime.ts
    // ~:35437-35450, getTerminalHandleForPaneKey falls through to
    // `getPtyRecordForPaneKey`+`issuePtyHandle` for a connected pty with a matching paneKey,
    // and `issuePtyHandle` (~:37263) unconditionally self-heals: it mints a `this.handles`
    // entry on first call whether or not this fix's `ensureLeaflessHandleRecord` call ever
    // ran. Empirically (probed against this exact fixture pre-commit) it returns a non-null
    // handle both before and after this diff — so that specific assertion would never
    // distinguish RED from GREEN and was dropped rather than written as a tautology. The
    // property this diff actually pins is upstream of that self-heal ladder: no `this.handles`
    // record exists, and `resolveLiveLeafForHandle`/`waitForLeafPtyId` (what the daemon-restart
    // 10s fix and this notice-timing fix both gate on) see nothing, until a real leaf binds or
    // a controller-inventory pass adopts the pty. Flagged for the chair; not blocking.
  })

  it('a controller inventory pass after the same fresh-spawn fixture creates the record (inventory site, not the spawn site, is the writer)', async () => {
    const runtime = new OrcaRuntimeService()
    const rt = internals(runtime)
    const handle = runtime.preAllocateHandleForPty(FRESH_PTY_ID)
    rt.registerPty(FRESH_PTY_ID, WORKTREE_ID, null, {
      tabId: FRESH_TAB_ID,
      leafId: FRESH_LEAF_ID
    })
    expect(rt.handles.has(handle)).toBe(false)

    const session: PtyProcessInfo = {
      id: FRESH_PTY_ID,
      cwd: '/tmp/wt',
      title: 'fresh-spawn-now-survived',
      incarnationId: INCARNATION_ID as unknown as PtyProcessInfo['incarnationId'],
      terminalHandle: handle
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
    expect(rt.handles.has(handle)).toBe(true)
    expect(runtime.resolveLiveLeafForHandle(handle)).toEqual({ ptyId: FRESH_PTY_ID })
  })
})
