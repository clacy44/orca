import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import {
  TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS,
  TERMINAL_PRESENCE_MAX_PARTICIPANTS
} from '../../terminal-presence-snapshot'
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

// The worst case the caps admit: every participant slot filled, every handle slot filled.
function cappedRoster(): RuntimeClientEvent {
  return {
    type: 'terminalPresence',
    seq: 7,
    participants: Array.from({ length: TERMINAL_PRESENCE_MAX_PARTICIPANTS }, (_, index) => ({
      participantId: `participant-${index}-0000000000000000000000`,
      label: `A very long device label ${index}`,
      kind: 'mobile' as const,
      attachedTerminals: Array.from(
        { length: TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS },
        (_unused, handleIndex) => `terminal_${index}_${handleIndex}`
      ),
      self: false
    })),
    truncated: true
  }
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

  // §4.2 under Q5, the inverse of the earlier mobile control: a phone is a participant and may see the
  // roster, so it receives it on BOTH paths — the fan-out branch and this direct snapshot loop, which
  // bypasses that branch entirely. A gate reinstated on either one alone would show up right here.
  it('sends a mobile listener the roster on both paths', async () => {
    const harness = makeHarness()
    await subscribe(harness, { clientKind: 'mobile' })

    expect(harness.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: false,
      participantId: null
    })
    expect(harness.presenceSnapshot).toHaveBeenCalledWith(null)
    expect(presenceEntries(harness)).toEqual([ROSTER])
  })

  // What bounds the relay cost is the caps, not a filter — so measure the worst case the caps allow.
  it('keeps a capped roster snapshot inside its serialized budget', async () => {
    const harness = makeHarness()
    harness.presenceSnapshot.mockReturnValue([cappedRoster()])
    await subscribe(harness, { clientKind: 'mobile' })

    const [snapshot] = presenceEntries(harness)
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    expect((snapshot as typeof ROSTER).participants).toHaveLength(
      TERMINAL_PRESENCE_MAX_PARTICIPANTS
    )
    // Why an upper bound and not an exact size: this is a relay budget — "one (re)subscribe cannot
    // cost a phone more than this" — not the byte count of today's field names. The fixture measures
    // ~38 KB, so the ceiling leaves room for a field without leaving room for an uncapped list.
    expect(bytes).toBeLessThan(64 * 1024)
  })

  // The other kind, asserted the same way, so neither branch can start depending on clientKind again.
  it('sends a runtime listener the roster snapshot listener-first', async () => {
    const harness = makeHarness()
    await subscribe(harness, { clientKind: 'runtime' })

    expect(harness.onClientEvent).toHaveBeenCalledWith(expect.any(Function), {
      consumesTerminalSideEffects: true,
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
