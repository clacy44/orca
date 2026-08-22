// Why: presence lands on two stream handlers that share nothing but a registry, so both suites drive the
// same stubbed runtime — a per-file copy is how one handler's coverage quietly drifts from the other's.
import { expect, vi } from 'vitest'
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

export const GRANT = 'device-runtime-1'
export const CONNECTION = 'conn-desktop-1'
export const PRESENCE_PTY_ID = 'pty-1'

export type BinaryStreamHandlers = Map<
  number,
  (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
>

export type StreamIdentity = {
  connectionId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}

export function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(false),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: PRESENCE_PTY_ID }),
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: PRESENCE_PTY_ID }),
    hasEstablishedSubscription: vi.fn().mockReturnValue(true),
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
    sendTerminal: vi
      .fn()
      .mockResolvedValue({ handle: 'terminal-1', accepted: true, bytesWritten: 1 }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    ...overrides
  } as unknown as OrcaRuntimeService
}

export function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function cleanupRecordingRuntime(
  cleanups: Map<string, () => void>,
  overrides: Partial<OrcaRuntimeService>
): OrcaRuntimeService {
  const subscriptionsByConnection = new Map<string, Set<string>>()
  return stubRuntime({
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void, connectionId?: string) => {
      const registered = connectionId ? subscriptionsByConnection.get(connectionId) : undefined
      if (connectionId && !registered) {
        subscriptionsByConnection.set(connectionId, new Set([id]))
      }
      registered?.add(id)
      cleanups.set(id, () => {
        subscriptionsByConnection.get(connectionId ?? '')?.delete(id)
        cleanup()
      })
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    }),
    // Why the real index rather than a blanket true: this predicate IS site (d)'s discriminator, so a
    // stub lets a control that is supposed to hang off a live lease pass with no lease at all.
    hasEstablishedSubscription: vi.fn(
      (connectionId: string) => (subscriptionsByConnection.get(connectionId)?.size ?? 0) > 0
    ),
    ...overrides
  })
}

export function startMultiplex(
  identity: StreamIdentity,
  cleanups = new Map<string, () => void>(),
  runtimeOverrides: Partial<OrcaRuntimeService> = {}
) {
  const messages: string[] = []
  const handlers: BinaryStreamHandlers = new Map()
  const connectionId = identity.connectionId ?? CONNECTION
  const runtime = cleanupRecordingRuntime(cleanups, runtimeOverrides)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (message) => messages.push(message),
    {
      ...identity,
      connectionId,
      sendBinary: () => true,
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  return { messages, handlers, cleanups, connectionId, runtime, dispatchPromise }
}

export function sendSubscribeFrame(
  handlers: BinaryStreamHandlers,
  capabilities: Record<string, number>,
  options: {
    streamId?: number
    clientId?: string
    terminal?: string
    clientType?: 'mobile' | 'desktop'
  } = {}
): void {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: options.streamId ?? 7,
          terminal: options.terminal ?? 'terminal-1',
          client: { id: options.clientId ?? 'desktop-1', type: options.clientType ?? 'desktop' },
          capabilities,
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
}

export function sendInputFrame(
  handlers: BinaryStreamHandlers,
  streamId: number,
  text: string,
  seq = 2
): void {
  handlers.get(streamId)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        streamId,
        seq,
        payload: new TextEncoder().encode(text)
      })
    )!
  )
}

export function streamResults(messages: readonly string[]): Record<string, unknown>[] {
  return messages
    .map((message) => JSON.parse(message).result)
    .filter((result): result is Record<string, unknown> => Boolean(result))
}

export async function awaitSubscribed(
  messages: readonly string[]
): Promise<Record<string, unknown>> {
  await vi.waitFor(() =>
    expect(streamResults(messages).some((result) => result.type === 'subscribed')).toBe(true)
  )
  return streamResults(messages).find((result) => result.type === 'subscribed')!
}

// Why dispatchStreaming for a non-streaming method: that is the only path that threads socket identity
// (gap 4), so a plain dispatch() would test an anonymous caller and pass for the wrong reason.
export async function dispatchWithIdentity(
  method: string,
  params: unknown,
  identity: StreamIdentity,
  runtime: OrcaRuntimeService = stubRuntime()
): Promise<Record<string, unknown>[]> {
  const messages: string[] = []
  await new RpcDispatcher({ runtime, methods: TERMINAL_METHODS }).dispatchStreaming(
    makeRequest(method, params),
    (message) => messages.push(message),
    { ...identity }
  )
  return messages.map((message) => JSON.parse(message))
}

export function startSubscribe(
  identity: StreamIdentity,
  params: Record<string, unknown>,
  cleanups = new Map<string, () => void>(),
  runtimeOverrides: Partial<OrcaRuntimeService> = {}
) {
  const messages: string[] = []
  const runtime = cleanupRecordingRuntime(cleanups, runtimeOverrides)
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const binaryHandlers: BinaryStreamHandlers = new Map()
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.subscribe', params),
    (message) => messages.push(message),
    {
      ...identity,
      connectionId: identity.connectionId ?? CONNECTION,
      sendBinary: () => true,
      registerBinaryStreamHandler: (streamId, handler) => {
        binaryHandlers.set(streamId, handler)
        return () => binaryHandlers.delete(streamId)
      }
    }
  )
  return { messages, binaryHandlers, cleanups, dispatchPromise, runtime }
}
