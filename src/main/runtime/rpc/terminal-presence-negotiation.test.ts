import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { terminalPresenceRegistry } from '../terminal-presence-registry'

const GRANT = 'device-runtime-1'
const CONNECTION = 'conn-desktop-1'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(false),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    serializeAuthoritativeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    ...overrides
  } as unknown as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

type Identity = { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }

function startMultiplex(identity: Identity, cleanups = new Map<string, () => void>()) {
  const messages: string[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const runtime = stubRuntime({
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
    })
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (message) => messages.push(message),
    {
      connectionId: CONNECTION,
      ...identity,
      sendBinary: () => true,
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  return { messages, handlers, cleanups, dispatchPromise }
}

function sendSubscribeFrame(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>,
  capabilities: Record<string, number>
) {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities,
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
}

async function awaitSubscribed(messages: string[]): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(
      messages.map((message) => JSON.parse(message).result).some((r) => r?.type === 'subscribed')
    ).toBe(true)
  )
  return messages
    .map((message) => JSON.parse(message).result)
    .find((result) => result?.type === 'subscribed')
}

function registerDesktopGrant(): string {
  return terminalPresenceRegistry.registerConnection({
    connectionId: CONNECTION,
    pairedDeviceId: GRANT,
    label: 'Ana laptop',
    kind: 'runtime'
  }).participantId
}

beforeEach(() => {
  terminalPresenceRegistry.reset()
})

describe('terminal.multiplex presence negotiation', () => {
  it('echoes the capability and the resolved participant when the client advertises presence', async () => {
    const participantId = registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { ackOutput: 1, outputPause: 1, presence: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ outputPause: 1, presence: 1 })
    expect(subscribed.presence).toEqual({
      participantId,
      label: 'Ana laptop',
      kind: 'runtime',
      self: true
    })
    // Why: the participantId is a session-scoped display handle; the grant id is the relay binding
    // identity and the on-disk navigation key, and never crosses to a peer.
    expect(JSON.stringify(subscribed)).not.toContain(GRANT)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('leaves the subscribed payload byte-identical when presence is not advertised', async () => {
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { ackOutput: 1, outputPause: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    // Why: the negative control is the whole payload, not just the absence of one key — a new key
    // anywhere would reach an old client that negotiated nothing.
    expect(subscribed).toEqual({
      type: 'subscribed',
      streamId: 7,
      terminal: 'terminal-1',
      cols: 120,
      rows: 40,
      displayMode: 'auto',
      seq: 1,
      capabilities: { outputPause: 1 },
      truncated: false
    })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('omits presence entirely when a negotiated connection maps to no tracked participant', async () => {
    // Why: the tracked row carries this very grant, so only a per-connection lookup can reject it —
    // "the registry happened to be empty" and "the grant matched" both pass without one.
    terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-other-socket',
      pairedDeviceId: GRANT,
      label: 'Ana laptop',
      kind: 'runtime'
    })
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { outputPause: 1, presence: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    // Why: negotiation still succeeded; only the unverifiable participantId is withheld.
    expect(subscribed.capabilities).toEqual({ outputPause: 1, presence: 1 })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('refuses a participant when the socket grant and the dispatch envelope disagree', async () => {
    // Why: the registry row is host-observed and so is the envelope; if they ever disagree the safe
    // answer is to publish nothing. A mobile-scope envelope lands here too — no phone is a tracked
    // participant in this slice, so no phone stream may carry a participantId.
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'mobile' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { outputPause: 1, presence: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ outputPause: 1, presence: 1 })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('refuses a participant when only the paired grant disagrees', async () => {
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: 'device-runtime-9', clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { presence: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('attaches the stream under its connection-scoped key and drops it on close', async () => {
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { outputPause: 1, presence: 1 })
    await awaitSubscribed(harness.messages)

    expect(Array.from(terminalPresenceRegistry.attachmentsOf('pty-1').keys())).toEqual([
      `multiplex:${CONNECTION}:7`
    ])
    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
    expect(terminalPresenceRegistry.attachmentsOf('pty-1').size).toBe(0)
  })

  it('counts an un-negotiated multiplex stream as an attachment anyway', async () => {
    // Why: attachment is host-observed, not client-declared — a peer that negotiated nothing must
    // still be visible to everyone else, which is the whole reason the host owns this fact.
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { outputPause: 1 })
    await awaitSubscribed(harness.messages)

    expect(Array.from(terminalPresenceRegistry.attachmentsOf('pty-1').keys())).toEqual([
      `multiplex:${CONNECTION}:7`
    ])

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })

  it('strips unknown capability keys from a future client instead of failing the subscribe', async () => {
    registerDesktopGrant()
    const harness = startMultiplex({ pairedDeviceId: GRANT, clientKind: 'runtime' })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribeFrame(harness.handlers, { presence: 1, presenceTelepathy: 1 })

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ presence: 1 })
    expect(harness.messages.map((message) => JSON.parse(message).ok)).not.toContain(false)

    harness.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await harness.dispatchPromise
  })
})

function startSubscribe(
  identity: Identity,
  params: Record<string, unknown>,
  cleanups = new Map<string, () => void>(),
  runtimeOverrides: Partial<OrcaRuntimeService> = {}
) {
  const messages: string[] = []
  const runtime = stubRuntime({
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    }),
    ...runtimeOverrides
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.subscribe', params),
    (message) => messages.push(message),
    {
      connectionId: CONNECTION,
      ...identity,
      sendBinary: () => true,
      registerBinaryStreamHandler: () => () => {}
    }
  )
  return { messages, cleanups, dispatchPromise, runtime }
}

describe('terminal.subscribe presence negotiation', () => {
  it('echoes the capability and the participant on the live subscribed emit', async () => {
    const participantId = registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ presence: 1 })
    expect(subscribed.presence).toEqual({
      participantId,
      label: 'Ana laptop',
      kind: 'runtime',
      self: true
    })
    expect(JSON.stringify(subscribed)).not.toContain(GRANT)

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
  })

  it('leaves the live subscribed payload byte-identical when presence is not advertised', async () => {
    registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed).toEqual({
      type: 'subscribed',
      streamId: expect.any(Number),
      lines: [],
      truncated: false,
      cols: 120,
      rows: 40,
      displayMode: 'auto',
      seq: 1
    })
    expect('capabilities' in subscribed).toBe(false)
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
  })

  it('omits presence when a negotiated subscribe maps to no tracked participant', async () => {
    // Why: the tracked row carries this very grant on another socket, so only a per-connection
    // lookup can reject it — an unconditional participantId would sail past every other assertion.
    terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-other-socket',
      pairedDeviceId: GRANT,
      label: 'Ana laptop',
      kind: 'runtime'
    })
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    // Why: negotiation still succeeded; only the unverifiable participantId is withheld.
    expect(subscribed.capabilities).toEqual({ presence: 1 })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
  })

  it('refuses a subscribe participant to a tracked mobile grant', async () => {
    // Why: a phone IS tracked (the registry takes every authenticated socket), so only the kind gate
    // withholds the participantId — this slice publishes presence to runtime peers alone.
    terminalPresenceRegistry.registerConnection({
      connectionId: CONNECTION,
      pairedDeviceId: GRANT,
      label: 'Ana phone',
      kind: 'mobile'
    })
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'mobile' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ presence: 1 })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
  })

  it('refuses a subscribe participant when only the paired grant disagrees', async () => {
    registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: 'device-runtime-9', clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed.capabilities).toEqual({ presence: 1 })
    expect('presence' in subscribed).toBe(false)

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
  })

  it('attaches a binary stream subscriber and drops it on unsubscribe', async () => {
    registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1 }
      }
    )

    await awaitSubscribed(harness.messages)
    // Why: un-negotiated too — the host counts the attachment regardless of what the client asked for.
    expect(Array.from(terminalPresenceRegistry.attachmentsOf('pty-1').keys())).toEqual([
      expect.stringMatching(/^stream:\d+$/)
    ])

    harness.cleanups.get('terminal-1:desktop-1')?.()
    await harness.dispatchPromise
    expect(terminalPresenceRegistry.attachmentsOf('pty-1').size).toBe(0)
  })

  it('sends no capability echo and no presence on the no-PTY reply', async () => {
    // Why: only the live emit echoes, so a client that advertised presence on a handle with no PTY
    // must be told nothing — a later presence emit hung off the request rather than the echo would
    // reach a client that never learned negotiation succeeded.
    registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      { terminal: 'terminal-1', capabilities: { presence: 1 } },
      new Map(),
      { resolveLeafForHandle: vi.fn().mockReturnValue(null) }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    expect(subscribed).toEqual({
      type: 'subscribed',
      streamId: null,
      lines: [],
      truncated: false
    })
    await harness.dispatchPromise
  })

  it('tracks a viewless lease-only subscriber as an attachment and sends it no echo', async () => {
    registerDesktopGrant()
    const harness = startSubscribe(
      { pairedDeviceId: GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1, presence: 1 }
      }
    )

    const subscribed = await awaitSubscribed(harness.messages)
    // Why: the lease-only client renders no roster, so it gets no echo — but its peers must still see it.
    expect(subscribed).toEqual({
      type: 'subscribed',
      streamId: null,
      lines: [],
      truncated: false
    })
    expect(Array.from(terminalPresenceRegistry.attachmentsOf('pty-1').keys())).toEqual([
      `lease:${CONNECTION}:phone-1`
    ])

    harness.cleanups.get('terminal-1:phone-1')?.()
    await harness.dispatchPromise
    expect(terminalPresenceRegistry.attachmentsOf('pty-1').size).toBe(0)
  })
})
