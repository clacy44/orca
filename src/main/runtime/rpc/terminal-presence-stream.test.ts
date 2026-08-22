import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { terminalPresenceRegistry } from '../terminal-presence-registry'
import {
  TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS,
  TERMINAL_PRESENCE_COALESCE_WINDOW_MS
} from '../terminal-presence-change-notifier'
import { TERMINAL_PRESENCE_ACTIVITY_TTL_MS } from '../terminal-presence-activity-rows'
import {
  CONNECTION,
  GRANT,
  PRESENCE_PTY_ID,
  awaitSubscribed,
  dispatchWithIdentity,
  sendInputFrame,
  sendSubscribeFrame,
  startMultiplex,
  startSubscribe,
  streamResults
} from './terminal-presence-stream-test-harness'

const PEER_CONNECTION = 'conn-desktop-2'
const PEER_GRANT = 'device-runtime-2'
const CHAT_CONNECTION = 'conn-chat-1'
const CHAT_GRANT = 'device-mobile-1'

type PresenceRow = {
  participantId: string
  label: string
  kind: string
  typing: boolean
  writing: boolean
  since: number
  self: boolean
}

function presenceEvents(messages: readonly string[]): PresenceRow[][] {
  return streamResults(messages)
    .filter((result) => result.type === 'terminal-presence')
    .map((result) => result.participants as PresenceRow[])
}

function lastPresence(messages: readonly string[]): PresenceRow[] {
  return presenceEvents(messages).at(-1) ?? []
}

function registerGrant(
  connectionId: string,
  pairedDeviceId: string,
  label: string,
  kind: 'runtime' | 'mobile' = 'runtime'
): string {
  return terminalPresenceRegistry.registerConnection({
    connectionId,
    pairedDeviceId,
    label,
    kind
  }).participantId
}

// Why installed before the streams open: one clock must drive every stamp, coalescer window and TTL
// expiry in the test. Freezing mid-flight would strand timers already armed on the real clock.
function useOnePresenceClock(): void {
  vi.useFakeTimers()
}

async function startNegotiatedMultiplex(
  connectionId: string,
  pairedDeviceId: string,
  options: {
    streamId?: number
    clientId?: string
    presence?: boolean
    clientType?: 'mobile' | 'desktop'
    runtimeOverrides?: Partial<OrcaRuntimeService>
  } = {}
) {
  const harness = startMultiplex(
    { connectionId, pairedDeviceId, clientKind: 'runtime' },
    new Map(),
    options.runtimeOverrides
  )
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  sendSubscribeFrame(harness.handlers, options.presence === false ? {} : { presence: 1 }, {
    streamId: options.streamId ?? 7,
    clientId: options.clientId ?? `desktop-${connectionId}`,
    clientType: options.clientType
  })
  await awaitSubscribed(harness.messages)
  return harness
}

async function startNegotiatedSubscribe(
  connectionId: string,
  pairedDeviceId: string,
  clientId: string,
  presence = true,
  runtimeOverrides: Partial<OrcaRuntimeService> = {}
) {
  const harness = startSubscribe(
    { connectionId, pairedDeviceId, clientKind: 'runtime' },
    {
      terminal: 'terminal-1',
      client: { id: clientId, type: 'desktop' },
      viewport: { cols: 120, rows: 40 },
      capabilities: { terminalBinaryStream: 1, ...(presence ? { presence: 1 } : {}) }
    },
    new Map(),
    runtimeOverrides
  )
  const subscribed = await awaitSubscribed(harness.messages)
  return { ...harness, streamId: subscribed.streamId as number, clientId }
}

// Why a real lease: §4.6 builds the phone's write control on a client whose only stream is a lease-only
// subscribe, and the harness's own subscription index is what tells that apart from a headless one-shot.
async function startLeaseOnlySubscribe() {
  const harness = startSubscribe(
    { connectionId: CHAT_CONNECTION, pairedDeviceId: CHAT_GRANT, clientKind: 'mobile' },
    {
      terminal: 'terminal-1',
      client: { id: 'phone-1', type: 'mobile' },
      capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
    }
  )
  await awaitSubscribed(harness.messages)
  return harness
}

function chatSend(runtime: OrcaRuntimeService): Promise<Record<string, unknown>[]> {
  return dispatchWithIdentity(
    'terminal.send',
    { terminal: 'terminal-1', text: 'hello' },
    { connectionId: CHAT_CONNECTION, pairedDeviceId: CHAT_GRANT, clientKind: 'mobile' },
    runtime
  )
}

beforeEach(() => {
  terminalPresenceRegistry.reset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal.multiplex presence events', () => {
  it('emits one self row per stream and flips a peer to typing on a coalesced change', async () => {
    useOnePresenceClock()
    const selfParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const peerParticipantId = registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: 9,
      clientId: 'ben'
    })
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // Why per stream: `self` is resolved against the emitting stream's own participant, so one shared
    // payload would render a user as their own peer — the failure §5 calls silent by construction.
    expect(
      lastPresence(ana.messages)
        .map((row) => row.participantId)
        .sort()
    ).toEqual([selfParticipantId, peerParticipantId].sort())
    expect(lastPresence(ana.messages).filter((row) => row.self)).toEqual([
      expect.objectContaining({ participantId: selfParticipantId })
    ])
    expect(lastPresence(ben.messages).filter((row) => row.self)).toEqual([
      expect.objectContaining({ participantId: peerParticipantId, label: 'Ben laptop' })
    ])

    sendInputFrame(ben.handlers, 9, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    const rows = lastPresence(ana.messages)
    expect(rows.find((row) => row.participantId === selfParticipantId)).toMatchObject({
      typing: false,
      writing: false,
      self: true
    })
    expect(rows.find((row) => row.participantId === peerParticipantId)).toEqual({
      participantId: peerParticipantId,
      label: 'Ben laptop',
      kind: 'runtime',
      typing: true,
      // Why: an interactive stamp must never light the grant flag — the two maps are the whole
      // provenance split, and one shared field would satisfy every other assertion here.
      writing: false,
      since: expect.any(Number),
      self: false
    })

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('sends zero presence events to an un-negotiated stream while a peer attaches and types', async () => {
    useOnePresenceClock()
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, {
      clientId: 'ana',
      presence: false
    })
    expect(presenceEvents(ana.messages)).toEqual([])

    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: 9,
      clientId: 'ben'
    })
    sendInputFrame(ben.handlers, 9, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    // Why non-vacuous: the negotiated peer on the same PTY saw its own attach and its own typing over
    // this window, so the silence below is the capability gate and not an absent change feed.
    expect(lastPresence(ben.messages).some((row) => row.typing)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    expect(presenceEvents(ana.messages)).toEqual([])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('sends zero presence events to a stream that self-declares mobile', async () => {
    useOnePresenceClock()
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, {
      clientId: 'ana',
      clientType: 'mobile'
    })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: 9,
      clientId: 'ben'
    })

    sendInputFrame(ben.handlers, 9, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    // Why non-vacuous: the self-declared phone IS attached to this PTY and shows up on Ben's roster, so
    // the silence below is the isMobile gate rather than an empty change feed.
    expect(lastPresence(ben.messages)).toHaveLength(2)
    expect(lastPresence(ben.messages).some((row) => row.typing)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    expect(presenceEvents(ana.messages)).toEqual([])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('coalesces a 50-input burst and fires the typing falling edge exactly once', async () => {
    useOnePresenceClock()
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const before = presenceEvents(ana.messages).length

    const gapMs = 50
    const inputs = 50
    for (let index = 0; index < inputs; index += 1) {
      sendInputFrame(ana.handlers, 7, 'x', index + 2)
      vi.advanceTimersByTime(gapMs)
    }
    const burstMs = inputs * gapMs
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    const duringBurst = presenceEvents(ana.messages).length - before

    expect(duringBurst).toBeLessThanOrEqual(
      Math.ceil(
        (burstMs + TERMINAL_PRESENCE_COALESCE_WINDOW_MS) / TERMINAL_PRESENCE_COALESCE_WINDOW_MS
      )
    )
    // Why: the max-wait cap is the half of the contract a plain trailing-edge timer silently drops —
    // without it a sustained typist publishes nothing at all until they stop.
    expect(duringBurst).toBeGreaterThanOrEqual(
      Math.floor(burstMs / TERMINAL_PRESENCE_COALESCE_MAX_WAIT_MS)
    )
    expect(lastPresence(ana.messages)[0]).toMatchObject({ typing: true })

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    const afterFallingEdge = presenceEvents(ana.messages).length
    // Why the falling edge is owned by the coalescer: expiry is the one change no mutation reports, so
    // without it the last payload would leave a dead "typing" on screen forever.
    expect(afterFallingEdge).toBe(before + duringBurst + 1)
    expect(lastPresence(ana.messages)[0]).toMatchObject({ typing: false })

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 4)
    expect(presenceEvents(ana.messages).length).toBe(afterFallingEdge)

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await ana.dispatchPromise
  })

  it('flips typing on an input the mobile driver lock drops', async () => {
    useOnePresenceClock()
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    // Why a mobile driver against a desktop client: that is the one combination
    // isTerminalInputLockedForClient rejects, and the whole suite otherwise runs on an idle driver, so
    // the stamp could sit below the gate and every assertion here would still pass.
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, {
      clientId: 'ana',
      runtimeOverrides: { getDriver: vi.fn().mockReturnValue({ kind: 'mobile' }) }
    })

    sendInputFrame(ana.handlers, 7, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(
      lastPresence(ana.messages).find((row) => row.participantId === anaParticipantId)
    ).toMatchObject({ typing: true, writing: false })
    // Why non-vacuous: the keystroke provably never reached the PTY, so the row above is reporting
    // human intent and not a write that landed anyway.
    expect(ana.runtime.sendTerminal).not.toHaveBeenCalled()

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await ana.dispatchPromise
  })

  it('reads the TTL off the clock the registry wrote the stamps with', async () => {
    useOnePresenceClock()
    const selfParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    // Why the registry's clock is pointed away from wall time: the emit resolves `now` through the one
    // process-wide registry, so this is the only place a test can separate the two domains. A Date.now()
    // literal in the emit would compare these stamps against a clock that never wrote one, and the row
    // would read idle the instant it was typed.
    vi.spyOn(terminalPresenceRegistry, 'now').mockReturnValue(5_000)
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })

    sendInputFrame(ana.handlers, 7, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(
      lastPresence(ana.messages).find((row) => row.participantId === selfParticipantId)
    ).toMatchObject({ typing: true })

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    await ana.dispatchPromise
  })

  it('keeps a terminal.send burst out of the interactive map and off the typing flag', async () => {
    useOnePresenceClock()
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const chatParticipantId = registerGrant(CHAT_CONNECTION, CHAT_GRANT, 'Ana phone', 'mobile')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const phone = await startLeaseOnlySubscribe()

    sendInputFrame(ana.handlers, 7, 'x')
    for (let index = 0; index < 5; index += 1) {
      await chatSend(phone.runtime)
    }
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    const rows = lastPresence(ana.messages)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.participantId === anaParticipantId)).toMatchObject({
      typing: true,
      writing: false,
      self: true
    })
    // Why asserted on the emitted payload: a field mix-up between the two stamps is invisible in the
    // registry and only shows up in what a peer actually renders.
    expect(rows.find((row) => row.participantId === chatParticipantId)).toMatchObject({
      kind: 'mobile',
      typing: false,
      writing: true,
      self: false
    })
    // Why keyed on the stamp and not on membership: the phone IS in the interactive map — its lease is
    // an attachment its peers must see — so the control that matters is that five chat sends never
    // stamped it. A composer landing there would let automation swallow a human's keystroke (§2.6).
    expect(
      Array.from(terminalPresenceRegistry.attachmentsOf(PRESENCE_PTY_ID).entries()).map(
        ([key, attachment]) => [key, attachment.lastInteractiveInputAt > 0]
      )
    ).toEqual([
      [`multiplex:${CONNECTION}:7`, true],
      [`lease:${CHAT_CONNECTION}:phone-1`, false]
    ])
    expect(Array.from(terminalPresenceRegistry.grantWritesOf(PRESENCE_PTY_ID).keys())).toEqual([
      CHAT_GRANT
    ])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    phone.cleanups.get('terminal-1:phone-1')?.()
    await Promise.all([ana.dispatchPromise, phone.dispatchPromise])
  })

  it('stops stamping a phone whose lease-only subscription is gone', async () => {
    useOnePresenceClock()
    registerGrant(CHAT_CONNECTION, CHAT_GRANT, 'Ana phone', 'mobile')
    const phone = await startLeaseOnlySubscribe()
    await chatSend(phone.runtime)
    const stampedAt = terminalPresenceRegistry.grantWritesOf(PRESENCE_PTY_ID).get(CHAT_GRANT)
    expect(stampedAt).toBeGreaterThan(0)

    phone.cleanups.get('terminal-1:phone-1')?.()
    await phone.dispatchPromise
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    await chatSend(phone.runtime)

    // Why the same socket and the same grant: with the lease torn down this connection holds no
    // subscription, which is the only thing separating a phone's chat send from a headless agent's
    // one-shot — so the second send must leave the earlier stamp exactly where it was.
    expect(terminalPresenceRegistry.grantWritesOf(PRESENCE_PTY_ID).get(CHAT_GRANT)).toBe(stampedAt)

    vi.useRealTimers()
  })
})

describe('terminal.subscribe presence events', () => {
  it('mirrors the roster after the live subscribed emit and flips its own typing', async () => {
    useOnePresenceClock()
    const selfParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const harness = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')

    expect(presenceEvents(harness.messages)[0]).toEqual([
      expect.objectContaining({
        participantId: selfParticipantId,
        label: 'Ana laptop',
        typing: false,
        writing: false,
        self: true
      })
    ])
    // Why after the echo: a client learns presence is negotiated from `subscribed`, so an event ahead of
    // it would arrive on a stream that was never told the capability was granted.
    const types = streamResults(harness.messages).map((result) => result.type)
    expect(types.indexOf('terminal-presence')).toBeGreaterThan(types.indexOf('subscribed'))

    sendInputFrame(harness.binaryHandlers, harness.streamId, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(lastPresence(harness.messages)).toEqual([
      expect.objectContaining({ participantId: selfParticipantId, typing: true, self: true })
    ])

    vi.useRealTimers()
    harness.cleanups.get('terminal-1:ana')?.()
    await harness.dispatchPromise
  })

  it('flips typing on an input the mobile driver lock drops', async () => {
    useOnePresenceClock()
    const selfParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const harness = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana', true, {
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile' })
    })

    sendInputFrame(harness.binaryHandlers, harness.streamId, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(lastPresence(harness.messages)).toEqual([
      expect.objectContaining({ participantId: selfParticipantId, typing: true, writing: false })
    ])
    expect(harness.runtime.sendTerminal).not.toHaveBeenCalled()

    vi.useRealTimers()
    harness.cleanups.get('terminal-1:ana')?.()
    await harness.dispatchPromise
  })

  it('sends zero presence events to an un-negotiated subscribe while a peer types', async () => {
    useOnePresenceClock()
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana', false)
    const ben = await startNegotiatedSubscribe(PEER_CONNECTION, PEER_GRANT, 'ben')

    sendInputFrame(ben.binaryHandlers, ben.streamId, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(lastPresence(ben.messages).some((row) => row.typing)).toBe(true)

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    expect(presenceEvents(ana.messages)).toEqual([])

    vi.useRealTimers()
    ana.cleanups.get('terminal-1:ana')?.()
    ben.cleanups.get('terminal-1:ben')?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('marks exactly one self row on a mobile-scope negotiated subscribe', async () => {
    useOnePresenceClock()
    const desktopParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const phoneParticipantId = registerGrant(CHAT_CONNECTION, CHAT_GRANT, 'Ana phone', 'mobile')
    const desktop = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')
    // Why a real mobile-scope subscribe: the roster rows are built from every tracked connection with no
    // kind filter, so a phone whose self cannot resolve receives its own row rendered as a peer's.
    const phone = startSubscribe(
      { connectionId: CHAT_CONNECTION, pairedDeviceId: CHAT_GRANT, clientKind: 'mobile' },
      {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        viewport: { cols: 90, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1 }
      }
    )
    const subscribed = await awaitSubscribed(phone.messages)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(lastPresence(phone.messages).filter((row) => row.self)).toEqual([
      expect.objectContaining({ participantId: phoneParticipantId, kind: 'mobile' })
    ])
    expect(lastPresence(desktop.messages).filter((row) => row.self)).toEqual([
      expect.objectContaining({ participantId: desktopParticipantId })
    ])
    // Why still withheld: W2's own-identity object stays runtime-scope until S7 gives mobile rows their
    // staleness contract — the two gates are separate, and only this one is scoped by kind.
    expect('presence' in subscribed).toBe(false)

    vi.useRealTimers()
    desktop.cleanups.get('terminal-1:ana')?.()
    phone.cleanups.get('terminal-1:phone-1')?.()
    await Promise.all([desktop.dispatchPromise, phone.dispatchPromise])
  })

  it('stops emitting once the subscription is torn down', async () => {
    useOnePresenceClock()
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')
    const ben = await startNegotiatedSubscribe(PEER_CONNECTION, PEER_GRANT, 'ben')
    ana.cleanups.get('terminal-1:ana')?.()
    await ana.dispatchPromise
    const settled = presenceEvents(ana.messages).length

    sendInputFrame(ben.binaryHandlers, ben.streamId, 'x')
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS * 4)
    expect(presenceEvents(ana.messages).length).toBe(settled)

    vi.useRealTimers()
    ben.cleanups.get('terminal-1:ben')?.()
    await ben.dispatchPromise
  })
})
