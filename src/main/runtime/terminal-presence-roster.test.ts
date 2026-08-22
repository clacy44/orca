import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPresenceClientEvent } from '../../shared/runtime-client-events'
import { TerminalPresenceRegistry } from './terminal-presence-registry'
import {
  HOST_PARTICIPANT_ID,
  TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS,
  TERMINAL_PRESENCE_MAX_PARTICIPANTS,
  buildTerminalPresenceRosterParticipants,
  stampTerminalPresenceSelf
} from './terminal-presence-snapshot'
import {
  TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS,
  TERMINAL_PRESENCE_COALESCE_WINDOW_MS
} from './terminal-presence-change-notifier'
import { createTerminalPresenceRosterPublisher } from './terminal-presence-roster-publisher'

const PTY_ID = 'pty-1'

type Harness = {
  registry: TerminalPresenceRegistry
  published: RuntimeTerminalPresenceClientEvent[]
  publisher: ReturnType<typeof createTerminalPresenceRosterPublisher>
  established: Set<string>
  handles: Map<string, string>
}

function createHarness(): Harness {
  const registry = new TerminalPresenceRegistry({ now: () => Date.now() })
  const established = new Set<string>()
  const handles = new Map<string, string>()
  const published: RuntimeTerminalPresenceClientEvent[] = []
  const publisher = createTerminalPresenceRosterPublisher({
    registry,
    buildMembership: () =>
      buildTerminalPresenceRosterParticipants({
        registry,
        hasEstablishedSubscription: (connectionId) => established.has(connectionId),
        resolveTerminalHandle: (ptyId) => handles.get(ptyId) ?? null
      }),
    publish: (event) => published.push(event)
  })
  return { registry, published, publisher, established, handles }
}

function connect(harness: Harness, connectionId: string, pairedDeviceId: string, label: string) {
  harness.established.add(connectionId)
  return harness.registry.registerConnection({
    connectionId,
    pairedDeviceId,
    label,
    kind: 'runtime'
  })
}

function settle(): void {
  vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS + 1)
}

describe('terminal presence roster publisher', () => {
  let harness: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    harness = createHarness()
  })

  afterEach(() => {
    harness.publisher.dispose()
    vi.useRealTimers()
  })

  it('publishes a join once the grant crosses the publication threshold', () => {
    connect(harness, 'conn-1', 'grant-a', 'Ana laptop')
    settle()

    expect(harness.published).toHaveLength(1)
    expect(harness.published[0]?.seq).toBe(1)
    expect(harness.published[0]?.participants.map((row) => row.label)).toContain('Ana laptop')
  })

  // Why this is the load-bearing one: W8 shares the registry's change feed with the per-keystroke
  // stamps, so "membership only" is a property of the payload, not of the trigger. If a future field
  // that a keystroke can move joins these rows, this test — not production — is where it shows up.
  it('emits nothing at all for a typing burst', () => {
    connect(harness, 'conn-1', 'grant-a', 'Ana laptop')
    harness.handles.set(PTY_ID, 'term_1')
    harness.registry.attach(PTY_ID, 'multiplex:conn-1:1', 'conn-1')
    settle()
    const afterAttach = harness.published.length
    expect(afterAttach).toBe(1)

    for (let index = 0; index < 50; index += 1) {
      harness.registry.recordInteractiveInput(PTY_ID, 'multiplex:conn-1:1')
      vi.advanceTimersByTime(20)
    }
    // Why past the max-wait too: a starvation cap fires the coalescer mid-burst, so a payload that
    // carried activity would surface here even though no single window ever settled quietly.
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS + 1)

    expect(harness.published).toHaveLength(afterAttach)
  })

  it('publishes attach and detach as membership changes', () => {
    connect(harness, 'conn-1', 'grant-a', 'Ana laptop')
    harness.handles.set(PTY_ID, 'term_1')
    settle()

    harness.registry.attach(PTY_ID, 'multiplex:conn-1:1', 'conn-1')
    settle()
    const attached = harness.published.at(-1)
    expect(
      attached?.participants.find((row) => row.label === 'Ana laptop')?.attachedTerminals
    ).toEqual(['term_1'])

    harness.registry.detach(PTY_ID, 'multiplex:conn-1:1')
    settle()
    expect(
      harness.published.at(-1)?.participants.find((row) => row.label === 'Ana laptop')
        ?.attachedTerminals
    ).toEqual([])
    expect(harness.published.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  // The publication threshold (§2.1): the fresh socket every remote `orca` command opens registers no
  // subscription, so it must never flash a participant in and out of everyone's roster.
  it('never publishes a one-shot socket that holds no subscription', () => {
    harness.registry.registerConnection({
      connectionId: 'conn-oneshot',
      pairedDeviceId: 'grant-agent',
      label: 'coordinator',
      kind: 'runtime'
    })
    settle()

    expect(harness.published).toHaveLength(0)
    const snapshot = harness.publisher.snapshot()
    expect(snapshot.participants.map((row) => row.participantId)).toEqual([HOST_PARTICIPANT_ID])
  })

  it('collapses two sockets of one grant into one row whose attachments are the union', () => {
    const first = connect(harness, 'conn-1', 'grant-a', 'Ana laptop')
    const second = connect(harness, 'conn-2', 'grant-a', 'Ana laptop')
    expect(second.participantId).toBe(first.participantId)
    harness.handles.set('pty-a', 'term_a')
    harness.handles.set('pty-b', 'term_b')
    harness.registry.attach('pty-a', 'multiplex:conn-1:1', 'conn-1')
    harness.registry.attach('pty-b', 'multiplex:conn-2:1', 'conn-2')
    settle()

    const rows = harness.publisher
      .snapshot()
      .participants.filter((row) => row.participantId === first.participantId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.attachedTerminals.toSorted()).toEqual(['term_a', 'term_b'])
  })

  it('always carries the synthesized host row, even with nobody connected', () => {
    const snapshot = harness.publisher.snapshot()
    expect(snapshot.participants).toHaveLength(1)
    expect(snapshot.participants[0]?.kind).toBe('host')
    expect(snapshot.participants[0]?.attachedTerminals).toEqual([])
    expect(snapshot.seq).toBe(0)
  })
})

describe('terminal presence roster caps', () => {
  function membershipWith(participantCount: number, handlesPerParticipant: number) {
    const registry = new TerminalPresenceRegistry({ now: () => 1000 })
    const established = new Set<string>()
    const handles = new Map<string, string>()
    for (let index = 0; index < participantCount; index += 1) {
      const connectionId = `conn-${index}`
      established.add(connectionId)
      registry.registerConnection({
        connectionId,
        pairedDeviceId: `grant-${index}`,
        label: `peer-${index}`,
        kind: 'runtime'
      })
      for (let handleIndex = 0; handleIndex < handlesPerParticipant; handleIndex += 1) {
        const ptyId = `pty-${index}-${handleIndex}`
        handles.set(ptyId, `term_${index}_${handleIndex}`)
        registry.attach(ptyId, `multiplex:${connectionId}:${handleIndex}`, connectionId)
      }
    }
    return buildTerminalPresenceRosterParticipants({
      registry,
      hasEstablishedSubscription: (connectionId) => established.has(connectionId),
      resolveTerminalHandle: (ptyId) => handles.get(ptyId) ?? null
    })
  }

  // Why an under-cap control beside it: a `truncated` that is always set proves nothing about the cap.
  it('leaves truncated absent while the roster fits', () => {
    const membership = membershipWith(TERMINAL_PRESENCE_MAX_PARTICIPANTS - 1, 1)
    expect(membership.participants).toHaveLength(TERMINAL_PRESENCE_MAX_PARTICIPANTS)
    expect(membership.truncated).toBeUndefined()
  })

  it('caps participants and flags truncated once the roster overflows', () => {
    const membership = membershipWith(TERMINAL_PRESENCE_MAX_PARTICIPANTS + 5, 1)
    expect(membership.participants).toHaveLength(TERMINAL_PRESENCE_MAX_PARTICIPANTS)
    expect(membership.truncated).toBe(true)
  })

  it('caps attached handles per participant', () => {
    const membership = membershipWith(1, TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS + 3)
    const peer = membership.participants.find((row) => row.kind === 'runtime')
    expect(peer?.attachedTerminals).toHaveLength(TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS)
  })
})

describe('stampTerminalPresenceSelf', () => {
  const event: RuntimeTerminalPresenceClientEvent = {
    type: 'terminalPresence',
    seq: 4,
    participants: [
      { participantId: 'p-1', label: 'Ana', kind: 'runtime', attachedTerminals: [], self: false },
      { participantId: 'p-2', label: 'Ben', kind: 'mobile', attachedTerminals: [], self: false }
    ]
  }

  it('marks exactly the listener row', () => {
    const stamped = stampTerminalPresenceSelf(event, 'p-2')
    expect(stamped.participants.map((row) => row.self)).toEqual([false, true])
  })

  // The negative control for the fan-out default: an unidentified subscriber is nobody, and must not
  // fall back to "the first row" or crash.
  it('marks nothing when the listener has no participantId', () => {
    expect(stampTerminalPresenceSelf(event, null).participants.every((row) => !row.self)).toBe(true)
  })

  it('never mutates the shared payload', () => {
    stampTerminalPresenceSelf(event, 'p-1')
    expect(event.participants.every((row) => !row.self)).toBe(true)
  })
})
