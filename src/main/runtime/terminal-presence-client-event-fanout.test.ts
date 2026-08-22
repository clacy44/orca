import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { OrcaRuntimeService } from './orca-runtime'
import { terminalPresenceRegistry } from './terminal-presence-registry'

type Capture = { events: RuntimeClientEvent[] }

function presenceRows(capture: Capture) {
  const event = capture.events.findLast((entry) => entry.type === 'terminalPresence')
  return event?.type === 'terminalPresence' ? event : null
}

describe('terminalPresence fan-out', () => {
  let runtime: OrcaRuntimeService
  const unsubscribes: (() => void)[] = []

  beforeEach(() => {
    terminalPresenceRegistry.reset()
    runtime = new OrcaRuntimeService()
  })

  afterEach(() => {
    unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe())
    terminalPresenceRegistry.reset()
  })

  function listen(options?: {
    consumesPresence?: boolean
    participantId?: string | null
  }): Capture {
    const events: RuntimeClientEvent[] = []
    unsubscribes.push(runtime.onClientEvent((event) => events.push(event), options))
    return { events }
  }

  function connectEstablished(connectionId: string, pairedDeviceId: string, label: string): string {
    runtime.registerSubscriptionCleanup(`sub-${connectionId}`, () => {}, connectionId)
    return terminalPresenceRegistry.registerConnection({
      connectionId,
      pairedDeviceId,
      label,
      kind: 'runtime'
    }).participantId
  }

  // §4.3: a single shared payload would prove the per-listener resolution was skipped, so the
  // assertion is that ONE emitClientEvent leaves two listeners holding different `self` rows.
  it('gives two listeners different self rows from one emit', () => {
    const anaId = connectEstablished('conn-a', 'grant-a', 'Ana laptop')
    const benId = connectEstablished('conn-b', 'grant-b', 'Ben laptop')
    const ana = listen({ participantId: anaId })
    const ben = listen({ participantId: benId })

    // A third grant joining is the membership change both listeners are told about.
    connectEstablished('conn-c', 'grant-c', 'Cara laptop')
    runtime.flushTerminalPresenceRosterPublish()

    const anaEvent = presenceRows(ana)
    const benEvent = presenceRows(ben)
    expect(
      anaEvent?.participants.filter((row) => row.self).map((row) => row.participantId)
    ).toEqual([anaId])
    expect(
      benEvent?.participants.filter((row) => row.self).map((row) => row.participantId)
    ).toEqual([benId])
    // Not the same object: one stamped payload shared by both listeners is the failure this catches.
    expect(anaEvent).not.toBe(benEvent)
  })

  // The negative control for the fan-out default: no identity means nobody, never "the first row".
  it('marks nothing self for a listener registered without a participantId', () => {
    const anonymous = listen({ participantId: null })
    connectEstablished('conn-a', 'grant-a', 'Ana laptop')
    runtime.flushTerminalPresenceRosterPublish()

    const event = presenceRows(anonymous)
    expect(event?.participants.length).toBeGreaterThan(1)
    expect(event?.participants.every((row) => !row.self)).toBe(true)
  })

  it('drops terminalPresence for a listener that does not consume presence', () => {
    const phone = listen({ consumesPresence: false, participantId: 'p-phone' })
    const desktop = listen({ consumesPresence: true, participantId: 'p-desktop' })
    connectEstablished('conn-a', 'grant-a', 'Ana laptop')
    runtime.flushTerminalPresenceRosterPublish()

    expect(presenceRows(phone)).toBeNull()
    expect(presenceRows(desktop)).not.toBeNull()
  })
})
