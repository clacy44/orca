import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPresenceClientEvent } from '../../shared/runtime-client-events'
import { TerminalPresenceRegistry } from './terminal-presence-registry'
import { buildTerminalPresenceActivityRows } from './terminal-presence-activity-rows'
import { buildTerminalPresenceRosterParticipants } from './terminal-presence-snapshot'
import { createTerminalPresenceRosterPublisher } from './terminal-presence-roster-publisher'
import { createTerminalPresenceChangeNotifier } from './terminal-presence-change-notifier'
import { TERMINAL_PRESENCE_COALESCE_WINDOW_MS } from './terminal-presence-change-notifier'
import { MOBILE_PRESENCE_STALE_MS } from './terminal-presence-staleness'

const PTY_ID = 'pty-1'
const PHONE_CONNECTION = 'conn-phone'
const PHONE_KEY = `lease:${PHONE_CONNECTION}:phone-1`
// Mirrors orca-runtime's function-local re-subscribe absorber (it exports nothing to import).
const SOFT_LEAVE_GRACE_MS = 250

let clock = 1_000_000

function createRegistry(): TerminalPresenceRegistry {
  return new TerminalPresenceRegistry({ now: () => clock })
}

function attachPhone(registry: TerminalPresenceRegistry): void {
  registry.registerConnection({
    connectionId: PHONE_CONNECTION,
    pairedDeviceId: 'grant-phone',
    label: "Ben's phone",
    kind: 'mobile'
  })
  registry.attach(PTY_ID, PHONE_KEY, PHONE_CONNECTION)
}

function phoneRow(registry: TerminalPresenceRegistry) {
  return buildTerminalPresenceActivityRows({ registry, ptyId: PTY_ID, now: clock }).find(
    (row) => row.kind === 'mobile'
  )
}

describe('mobile presence staleness', () => {
  beforeEach(() => {
    clock = 1_000_000
  })

  it('flips stale at the horizon and back on the next inbound frame', () => {
    const registry = createRegistry()
    attachPhone(registry)

    clock += MOBILE_PRESENCE_STALE_MS - 1
    expect(phoneRow(registry)?.stale).toBeUndefined()
    expect(phoneRow(registry)?.lastSeenAt).toBeUndefined()

    clock += 1
    const stale = phoneRow(registry)
    expect(stale?.stale).toBe(true)
    expect(stale?.lastSeenAt).toBe(1_000_000)

    // Any inbound frame is the liveness proof — the phone does not have to type to come back.
    registry.stampInbound(PHONE_CONNECTION)
    expect(phoneRow(registry)?.stale).toBeUndefined()
  })

  // Why this control: a runtime-scope peer IS heartbeat-bounded, so blending it into the same suffix
  // would tell the reader two different liveness contracts in one word.
  it('never marks a runtime-scope peer stale, however long it is silent', () => {
    const registry = createRegistry()
    registry.registerConnection({
      connectionId: 'conn-desktop',
      pairedDeviceId: 'grant-desktop',
      label: 'Ana laptop',
      kind: 'runtime'
    })
    registry.attach(PTY_ID, 'multiplex:conn-desktop:1', 'conn-desktop')

    clock += MOBILE_PRESENCE_STALE_MS * 10
    const row = buildTerminalPresenceActivityRows({ registry, ptyId: PTY_ID, now: clock }).find(
      (candidate) => candidate.kind === 'runtime'
    )
    expect(row?.stale).toBeUndefined()
    expect(row?.lastSeenAt).toBeUndefined()
  })

  it('clears both activity flags on a stale row', () => {
    const registry = createRegistry()
    attachPhone(registry)
    registry.recordInteractiveInput(PTY_ID, PHONE_KEY)
    registry.recordGrantWrite(PTY_ID, 'grant-phone')
    expect(phoneRow(registry)?.typing).toBe(true)

    clock += MOBILE_PRESENCE_STALE_MS
    expect(phoneRow(registry)).toMatchObject({ stale: true, typing: false, writing: false })
  })

  // THE honesty ceiling (§2.1, Q5): there is no host-side liveness on a relay data socket and an idle
  // phone sends nothing, so reaping on silence would delete a live participant. Mark, never remove.
  it('never removes a row on silence alone, even after ten minutes', () => {
    const registry = createRegistry()
    attachPhone(registry)

    clock += 10 * 60 * 1000
    expect(phoneRow(registry)?.stale).toBe(true)
    expect(registry.connections().size).toBe(1)
    expect(Array.from(registry.attachmentsOf(PTY_ID).keys())).toEqual([PHONE_KEY])
    expect(
      buildTerminalPresenceRosterParticipants({
        registry,
        hasEstablishedSubscription: () => true,
        resolveTerminalHandle: () => 'term_1'
      }).participants.filter((row) => row.kind === 'mobile')
    ).toHaveLength(1)
  })

  // The other half of the contract: removal is lifecycle-driven, so an explicit disconnect DOES clear it.
  it('removes the row when the socket closes', () => {
    const registry = createRegistry()
    attachPhone(registry)
    clock += MOBILE_PRESENCE_STALE_MS

    registry.releaseConnection(PHONE_CONNECTION)

    expect(phoneRow(registry)).toBeUndefined()
    expect(registry.connections().size).toBe(0)
    expect(
      buildTerminalPresenceRosterParticipants({
        registry,
        hasEstablishedSubscription: () => true,
        resolveTerminalHandle: () => 'term_1'
      }).participants.filter((row) => row.kind === 'mobile')
    ).toHaveLength(0)
  })
})

describe('mobile presence staleness falling edges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clock = 1_000_000
    vi.setSystemTime(clock)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function advance(ms: number): void {
    clock += ms
    vi.advanceTimersByTime(ms)
  }

  // Without a deadline of its own the flip would wait for somebody else to move — a phone that stopped
  // answering produces no mutation at all, which is exactly what staleness reports.
  it('emits the per-PTY flip with no registry mutation behind it', () => {
    const registry = createRegistry()
    const notifier = createTerminalPresenceChangeNotifier({
      registry,
      now: () => clock,
      holdExpiryAt: () => null
    })
    attachPhone(registry)
    const emits: (boolean | undefined)[] = []
    const unsubscribe = notifier.subscribe(PTY_ID, () => {
      emits.push(phoneRow(registry)?.stale)
    })

    advance(MOBILE_PRESENCE_STALE_MS - 1)
    expect(emits).toEqual([])

    advance(1)
    expect(emits).toEqual([true])

    unsubscribe()
    notifier.dispose()
  })

  it('publishes the roster flip on its own timer and keeps the row', () => {
    const registry = createRegistry()
    const published: RuntimeTerminalPresenceClientEvent[] = []
    const publisher = createTerminalPresenceRosterPublisher({
      registry,
      buildMembership: () =>
        buildTerminalPresenceRosterParticipants({
          registry,
          hasEstablishedSubscription: () => true,
          resolveTerminalHandle: () => 'term_1'
        }),
      publish: (event) => published.push(event)
    })
    attachPhone(registry)
    advance(TERMINAL_PRESENCE_COALESCE_WINDOW_MS + 1)
    const afterJoin = published.length

    advance(MOBILE_PRESENCE_STALE_MS)

    expect(published.length).toBe(afterJoin + 1)
    const row = published.at(-1)?.participants.find((candidate) => candidate.kind === 'mobile')
    expect(row).toMatchObject({ stale: true, lastSeenAt: 1_000_000 })

    // And no second publish once it is already stale: the deadline is spent, not re-armed.
    advance(MOBILE_PRESENCE_STALE_MS * 2)
    expect(published.length).toBe(afterJoin + 1)

    publisher.dispose()
  })

  // §4.4: the phone re-subscribes inside orca-runtime's 250 ms absorber on every reconnect, and the
  // trailing-edge window (750 ms) is wider, so no intermediate payload is ever built.
  it('never flickers a mobile row across a re-subscribe inside the soft-leave grace', () => {
    const registry = createRegistry()
    const published: RuntimeTerminalPresenceClientEvent[] = []
    const publisher = createTerminalPresenceRosterPublisher({
      registry,
      buildMembership: () =>
        buildTerminalPresenceRosterParticipants({
          registry,
          hasEstablishedSubscription: () => true,
          resolveTerminalHandle: () => 'term_1'
        }),
      publish: (event) => published.push(event)
    })
    attachPhone(registry)
    advance(TERMINAL_PRESENCE_COALESCE_WINDOW_MS + 1)
    const afterJoin = published.length
    expect(
      published.at(-1)?.participants.find((row) => row.kind === 'mobile')?.attachedTerminals
    ).toEqual(['term_1'])

    registry.detach(PTY_ID, PHONE_KEY)
    advance(SOFT_LEAVE_GRACE_MS)
    registry.attach(PTY_ID, PHONE_KEY, PHONE_CONNECTION)
    advance(TERMINAL_PRESENCE_COALESCE_WINDOW_MS + 1)

    expect(published.length).toBe(afterJoin)

    publisher.dispose()
  })
})
