import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../shared/terminal-stream-protocol'

describe('remote runtime pty transport presence lane', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: { onResponse: (response: unknown) => void } | null = null

  function latestStreamId(): number {
    const frame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0]))
      .findLast((candidate) => candidate?.opcode === TerminalStreamOpcode.Subscribe)
    const payload = frame ? decodeTerminalStreamJson<{ streamId: number }>(frame.payload) : null
    if (!payload) {
      throw new Error('missing terminal subscribe frame')
    }
    return payload.streamId
  }

  function emitStreamEvent(result: Record<string, unknown>): void {
    subscriptionCallbacks?.onResponse({ ok: true, result })
  }

  // Why the state module is imported here and not at the top: vi.resetModules() rebuilds the graph per
  // case, so a statically bound copy would be a different Map from the one the transport writes.
  async function attachedTransport(): Promise<{
    presenceFor: (ptyId: string) => {
      participants: { participantId: string }[]
      arbitration: unknown
    }
    ptyId: string
    streamId: number
  }> {
    const { getPresenceForPty } = await import('@/lib/pane-manager/terminal-presence-state')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    transport.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks: {} })
    await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
    const ptyId = transport.getPtyId()
    if (!ptyId) {
      throw new Error('transport never resolved a ptyId')
    }
    return { presenceFor: getPresenceForPty, ptyId, streamId: latestStreamId() }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
    }))
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        return {
          ok: true,
          result: {
            terminal: {
              handle: 'terminal-1',
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        queueMicrotask(() => callbacks?.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
  })

  it('writes a decoded terminal-presence event into the pane lane', async () => {
    const { presenceFor, ptyId, streamId } = await attachedTransport()

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants: [
        {
          participantId: 'p-self',
          label: 'This desktop',
          kind: 'runtime',
          self: true,
          typing: false,
          writing: false,
          since: 10
        },
        {
          participantId: 'p-peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 20
        }
      ]
    })

    expect(presenceFor(ptyId).participants.map((row) => row.participantId)).toEqual([
      'p-self',
      'p-peer'
    ])
    expect(presenceFor(ptyId).arbitration).toBeNull()
  })

  it('carries an arbitration notice through unchanged', async () => {
    const { presenceFor, ptyId, streamId } = await attachedTransport()

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants: [
        {
          participantId: 'p-peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 20
        }
      ],
      arbitration: { heldFor: 'p-peer', until: 5000 }
    })

    expect(presenceFor(ptyId).arbitration).toEqual({ heldFor: 'p-peer', until: 5000 })
  })

  it('drops the hold on the first emit that omits the notice', async () => {
    // Why this is the whole clearing contract: the host retires a hold by OMITTING the field on its next
    // emit — once the re-press lands or the 5 s window closes — so a lane that only ever wrote a present
    // notice would strand "press again" on a pane whose keystrokes are landing again.
    const { presenceFor, ptyId, streamId } = await attachedTransport()
    const participants = [
      {
        participantId: 'p-peer',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        typing: true,
        writing: false,
        since: 20
      }
    ]

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants,
      arbitration: { heldFor: 'p-peer', until: 5000 }
    })
    expect(presenceFor(ptyId).arbitration).not.toBeNull()

    emitStreamEvent({ type: 'terminal-presence', streamId, participants })
    expect(presenceFor(ptyId).arbitration).toBeNull()
    expect(presenceFor(ptyId).participants).toHaveLength(1)
  })

  it('drops a malformed presence payload rather than rendering a partial roster', async () => {
    // Negative control for the decoder guard: an unusable row must leave the lane untouched, not
    // publish the rows that happened to parse.
    const { presenceFor, ptyId, streamId } = await attachedTransport()

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants: [
        {
          participantId: 'p-peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 20
        },
        { participantId: 'p-broken', label: 'Ben phone', kind: 'wristwatch' }
      ]
    })
    emitStreamEvent({ type: 'terminal-presence', streamId, participants: 'nobody' })

    expect(presenceFor(ptyId).participants).toEqual([])
  })

  // §2.7's "multiplex reconnecting" row: the pane's own stream is the only authority for its chip, so
  // when that stream dies the chip goes with it rather than freezing on the last frame it saw.
  it('clears the pane chip when its own stream ends mid-TTL', async () => {
    const { presenceFor, ptyId, streamId } = await attachedTransport()

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants: [
        {
          participantId: 'p-peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: true,
          writing: false,
          since: 20
        }
      ]
    })
    expect(presenceFor(ptyId).participants).toHaveLength(1)

    emitStreamEvent({ type: 'end', streamId })

    expect(presenceFor(ptyId).participants).toEqual([])
  })

  it('ignores an unparseable arbitration notice while keeping the roster', async () => {
    const { presenceFor, ptyId, streamId } = await attachedTransport()

    emitStreamEvent({
      type: 'terminal-presence',
      streamId,
      participants: [
        {
          participantId: 'p-peer',
          label: 'Ana laptop',
          kind: 'runtime',
          self: false,
          typing: false,
          writing: true,
          since: 20
        }
      ],
      arbitration: { heldFor: 7 }
    })

    expect(presenceFor(ptyId).participants).toHaveLength(1)
    expect(presenceFor(ptyId).arbitration).toBeNull()
  })
})
