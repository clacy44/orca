/**
 * S10-21g r162 (V2): after `systemctl restart orca-serve`, a mid-restart runtime answers
 * `no_connected_pty` for a survived handle whose record has not been reissued yet (R3's own
 * bug, fixed separately). Before this fix, `isRemoteTerminalGoneMessage` classified
 * `no_connected_pty` as lifecycle evidence unconditionally, retiring the pane permanently on
 * the very error a live recovery is supposed to ride out. It must instead be treated as a
 * retry signal while a recovery epoch is already live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'

describe('remote runtime pty transport: no_connected_pty during a live recovery epoch', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  function emitMultiplexReady(): void {
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
  }

  function latestSubscribeStreamId(): number {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
    if (!frame) {
      throw new Error('missing terminal subscribe frame')
    }
    const payload = decodeTerminalStreamJson<{ streamId: number }>(frame.payload)
    if (!payload) {
      throw new Error('invalid terminal subscribe payload')
    }
    return payload.streamId
  }

  function emitSnapshot(streamId: number, data: string): void {
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback' })
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(data)
      })
    )
    subscriptionCallbacks?.onBinary?.(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 3,
        payload: new Uint8Array()
      })
    )
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    runtimeCall.mockImplementation(async (args: { method: string; params?: unknown }) => {
      if (args.method === 'terminal.resolvePane') {
        const params = args.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-h1',
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: {} }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  it('retries rather than retires when no_connected_pty arrives while a recovery epoch is live', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    transport.attach({ existingPtyId: 'remote:env-1@@terminal-h1', callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const s1 = latestSubscribeStreamId()
    emitSnapshot(s1, 'initial screen')
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId: s1 } })
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('connected'))
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-h1')

    // Step 1: a plain recoverable connection error opens a live recovery epoch (isActive=true).
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId: s1, message: 'remote runtime connection closed' }
    })
    await vi.waitFor(() => expect(transport.getRecoveryState?.().phase).toBe('recovering'))

    // Step 2: while that epoch is still live, the mid-restart runtime answers no_connected_pty
    // for the not-yet-reissued handle.
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'error', streamId: s1, message: 'no_connected_pty' }
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(onPtyExit).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-h1')
    expect(transport.isConnected()).toBe(false) // mid-recovery, not yet resubscribed — but not retired
    transport.destroy?.()
  })
})
