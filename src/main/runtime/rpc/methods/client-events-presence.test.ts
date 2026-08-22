import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import { isStreamingMethod, type RpcContext, type RpcStreamingMethod } from '../core'
// Why via the index: importing client-events directly trips its module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from './index'

const subscribeMethod = ALL_RPC_METHODS.find(
  (method) => method.name === 'runtime.clientEvents.subscribe' && isStreamingMethod(method)
) as RpcStreamingMethod

const ROSTER: RuntimeClientEvent = {
  type: 'terminalPresence',
  seq: 3,
  participants: [
    { participantId: 'host', label: 'devbox', kind: 'host', attachedTerminals: [], self: false },
    {
      participantId: 'p-ana',
      label: 'Ana laptop',
      kind: 'runtime',
      attachedTerminals: ['term_1'],
      self: false
    }
  ]
}

type Harness = {
  runtime: OrcaRuntimeService
  onClientEvent: ReturnType<typeof vi.fn>
  presenceSnapshot: ReturnType<typeof vi.fn>
  cleanups: (() => void)[]
  emitted: unknown[]
}

function makeHarness(): Harness {
  const cleanups: (() => void)[] = []
  const emitted: unknown[] = []
  const onClientEvent = vi.fn(() => () => {})
  const presenceSnapshot = vi.fn((_participantId?: string | null) => [ROSTER])
  const runtime = {
    onClientEvent,
    getTerminalPresenceClientEventSnapshot: presenceSnapshot,
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      cleanups.push(cleanup)
    }
  } as unknown as OrcaRuntimeService
  return { runtime, onClientEvent, presenceSnapshot, cleanups, emitted }
}

async function subscribe(harness: Harness, ctx: Partial<RpcContext>): Promise<void> {
  const done = subscribeMethod.handler(
    undefined,
    { runtime: harness.runtime, connectionId: 'conn-1', ...ctx } as RpcContext,
    (event: unknown) => harness.emitted.push(event)
  )
  harness.cleanups.forEach((cleanup) => cleanup())
  await done
}

function presenceEntries(harness: Harness): unknown[] {
  return harness.emitted.filter((event) => (event as { type?: string }).type === 'terminalPresence')
}

describe('runtime.clientEvents.subscribe presence gating', () => {
  beforeEach(() => {
    terminalPresenceRegistry.reset()
  })

  afterEach(() => {
    terminalPresenceRegistry.reset()
  })

  // §4.2 negative, on the path the fan-out filter cannot see: the subscribe snapshot emits directly,
  // so a phone gated only in emitClientEvent would still be handed the whole roster on every
  // (re)subscribe — the exact frames the filter exists to keep off the relay.
  it('sends a mobile listener no presence on either path', async () => {
    const harness = makeHarness()
    await subscribe(harness, { clientKind: 'mobile' })

    expect(harness.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false,
      consumesPresence: false,
      participantId: null
    })
    expect(harness.presenceSnapshot).not.toHaveBeenCalled()
    expect(presenceEntries(harness)).toEqual([])
  })

  // The positive control that makes the test above non-vacuous.
  it('sends a runtime listener the roster snapshot listener-first', async () => {
    const harness = makeHarness()
    await subscribe(harness, { clientKind: 'runtime' })

    expect(harness.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true,
      consumesPresence: true,
      participantId: null
    })
    expect(harness.presenceSnapshot).toHaveBeenCalledWith(null)
    expect(presenceEntries(harness)).toEqual([ROSTER])
    // Listener-first: the roster must precede the ready frame, or a reconnect races its own snapshot.
    const typeAt = (index: number): unknown => (harness.emitted[index] as { type?: string }).type
    expect(typeAt(0)).toBe('terminalPresence')
    expect(
      harness.emitted.findIndex((event) => (event as { type?: string }).type === 'ready')
    ).toBe(1)
  })

  it('resolves the subscriber own participantId from its socket', async () => {
    const harness = makeHarness()
    const participant = terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-1',
      pairedDeviceId: 'grant-a',
      label: 'Ana laptop',
      kind: 'runtime'
    })

    await subscribe(harness, { clientKind: 'runtime', pairedDeviceId: 'grant-a' })

    expect(harness.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true,
      consumesPresence: true,
      participantId: participant.participantId
    })
    expect(harness.presenceSnapshot).toHaveBeenCalledWith(participant.participantId)
  })

  // A grant that does not match the socket's tracked participant is nobody, not the tracked one.
  it('resolves no participantId when the envelope grant disagrees with the socket', async () => {
    const harness = makeHarness()
    terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-1',
      pairedDeviceId: 'grant-a',
      label: 'Ana laptop',
      kind: 'runtime'
    })

    await subscribe(harness, { clientKind: 'runtime', pairedDeviceId: 'grant-b' })

    expect(harness.presenceSnapshot).toHaveBeenCalledWith(null)
  })
})
