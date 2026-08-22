import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { terminalPresenceRegistry } from '../terminal-presence-registry'
import {
  ARBITRATION_REPROMPT_MS,
  activeTerminalPresenceHoldNotice,
  resetTerminalPresenceArbitrationForTest
} from '../terminal-presence-arbitration'
import { TERMINAL_PRESENCE_ACTIVITY_TTL_MS } from '../terminal-presence-activity-rows'
import { TERMINAL_PRESENCE_COALESCE_WINDOW_MS } from '../terminal-presence-change-notifier'
import { HOST_PARTICIPANT_ID } from '../terminal-presence-snapshot'
import {
  CONNECTION,
  GRANT,
  type BinaryStreamHandlers,
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
const SECOND_WINDOW_CONNECTION = 'conn-desktop-1b'
const CHAT_CONNECTION = 'conn-chat-1'
const CHAT_GRANT = 'device-mobile-1'
const BEN_STREAM_ID = 9
// Why its own width: the claim frame's cols is what tells a parked claim apart from the handshake's.
const CLAIM_COLS = 100

function presenceResults(messages: readonly string[]): Record<string, unknown>[] {
  return streamResults(messages).filter((result) => result.type === 'terminal-presence')
}

function lastPresence(messages: readonly string[]): Record<string, unknown> | undefined {
  return presenceResults(messages).at(-1)
}

function participantRows(
  messages: readonly string[]
): { participantId: string; kind: string; typing: boolean; writing: boolean }[] {
  return (lastPresence(messages)?.participants ?? []) as {
    participantId: string
    kind: string
    typing: boolean
    writing: boolean
  }[]
}

// Why a raw frame: the claim tail is the only way to park a keystroke long enough for a peer to start
// typing underneath it, which is the whole reason the predicate is consulted a second time.
function sendClaimViewportFrame(handlers: BinaryStreamHandlers, streamId: number): void {
  handlers.get(streamId)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.ClaimViewport,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ cols: CLAIM_COLS, rows: 30 })
      })
    )!
  )
}

// Why a raw frame: detaching mid-keystroke is the only way to reach the second consult with the stream
// already gone, which is exactly where an arm-then-check ordering spends a nudge nobody can read.
function sendUnsubscribeFrame(handlers: BinaryStreamHandlers, streamId: number): void {
  handlers.get(streamId)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Unsubscribe,
        streamId,
        seq: 2,
        payload: new Uint8Array()
      })
    )!
  )
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

async function startNegotiatedMultiplex(
  connectionId: string,
  pairedDeviceId: string,
  options: {
    streamId?: number
    clientId?: string
    presence?: boolean
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
    clientId: options.clientId ?? `desktop-${connectionId}`
  })
  await awaitSubscribed(harness.messages)
  return { ...harness, streamId: options.streamId ?? 7 }
}

async function startNegotiatedSubscribe(
  connectionId: string,
  pairedDeviceId: string,
  clientId: string,
  presence = true
) {
  const harness = startSubscribe(
    { connectionId, pairedDeviceId, clientKind: 'runtime' },
    {
      terminal: 'terminal-1',
      client: { id: clientId, type: 'desktop' },
      viewport: { cols: 120, rows: 40 },
      capabilities: { terminalBinaryStream: 1, ...(presence ? { presence: 1 } : {}) }
    }
  )
  const subscribed = await awaitSubscribed(harness.messages)
  return { ...harness, streamId: subscribed.streamId as number, clientId }
}

// Why a real lease: the phone's chat writes are attributed only while its grant holds a live
// subscription, so a stubbed index would let the site-(d) controls below pass with no lease at all.
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

function chatSend(runtime: OrcaRuntimeService, text = 'chat'): Promise<Record<string, unknown>[]> {
  return dispatchWithIdentity(
    'terminal.send',
    { terminal: 'terminal-1', text },
    { connectionId: CHAT_CONNECTION, pairedDeviceId: CHAT_GRANT, clientKind: 'mobile' },
    runtime
  )
}

// Why advanceTimersByTimeAsync and not advanceTimersByTime: the write sits behind the async claim tail,
// so a synchronous advance would assert "no PTY write" before the tail had a chance to run.
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function sentTexts(runtime: OrcaRuntimeService): string[] {
  return (
    runtime.sendTerminal as unknown as { mock: { calls: [string, { text: string }][] } }
  ).mock.calls.map((call) => call[1].text)
}

beforeEach(() => {
  terminalPresenceRegistry.reset()
  resetTerminalPresenceArbitrationForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal.multiplex soft arbitration', () => {
  it('holds a peer once and lets the re-press through inside the window', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const benParticipantId = registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    sendInputFrame(ana.handlers, 7, 'a')
    await settle()
    expect(sentTexts(ana.runtime)).toEqual(['a'])

    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()

    expect(lastPresence(ben.messages)?.arbitration).toEqual({
      heldFor: anaParticipantId,
      until: expect.any(Number)
    })
    // The hold is a drop, not a queue: nothing reaches the PTY, then or later.
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()
    // Why still typing: presence reports human intent, so a peer who goes dark exactly when blocked is
    // the worse failure — and the holder must be able to see the collision they caused.
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(
      participantRows(ana.messages).find((row) => row.participantId === benParticipantId)
    ).toMatchObject({ typing: true, writing: false })

    await settle(100)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'c', 3)
    await settle()
    expect(sentTexts(ben.runtime)).toEqual(['c'])

    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    // Why absence and not a falsy value: the field is omitted entirely, which is what clears the chip.
    expect('arbitration' in (lastPresence(ben.messages) ?? {})).toBe(false)

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('retires the notice on its own emit when the window closes unanswered', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    sendInputFrame(ana.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()
    expect(lastPresence(ben.messages)?.arbitration).toMatchObject({ heldFor: anaParticipantId })
    const heldEmits = presenceResults(ben.messages).length

    // Why nobody types through this: the 5 s re-press window outlives the 3 s activity TTL, so every emit
    // the STAMPS can produce is already behind us — a hold with no emit of its own strands "press again"
    // on the pane for as long as both humans stay quiet, which is the ordinary end of a collision.
    await settle(ARBITRATION_REPROMPT_MS)

    expect(presenceResults(ben.messages).length).toBeGreaterThan(heldEmits)
    expect('arbitration' in (lastPresence(ben.messages) ?? {})).toBe(false)

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('never counters the incumbent typist with the keystroke it just held', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const benParticipantId = registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    sendInputFrame(ana.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()
    expect(lastPresence(ben.messages)?.arbitration).toMatchObject({ heldFor: anaParticipantId })

    // Ben's stamp is fresh — §4.5 stamps before the gate — but the keystroke behind it was DROPPED, so
    // it must not take a character from Ana in return. §2.6 promises the INTERRUPTING party one bump.
    await settle(10)
    sendInputFrame(ana.handlers, 7, 'a', 3)
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(sentTexts(ana.runtime)).toEqual(['a', 'a'])
    expect(presenceResults(ana.messages).every((event) => !('arbitration' in event))).toBe(true)

    // Non-vacuous: once Ben's re-press lands his typing is real again, and Ana pays her own single bump.
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'c', 4)
    await settle()
    expect(sentTexts(ben.runtime)).toEqual(['c'])
    await settle(10)
    sendInputFrame(ana.handlers, 7, 'a', 5)
    await settle()
    expect(sentTexts(ana.runtime)).toEqual(['a', 'a'])
    expect(lastPresence(ana.messages)?.arbitration).toMatchObject({ heldFor: benParticipantId })

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('holds synchronously, before the claim tail it would otherwise schedule', async () => {
    // Why pinned on the sync consult: the tail is where the SECOND consult lives, so a wiring that kept
    // only that one would still pass every other case here — and would hand a held keystroke to the
    // claim machinery before deciding to drop it.
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    sendInputFrame(ana.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')

    expect(lastPresence(ben.messages)?.arbitration).toMatchObject({ until: expect.any(Number) })

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('consults again inside the claim tail when a peer starts typing underneath it', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    let releaseClaim = (): void => {}
    const claimed = new Promise<boolean>((resolve) => {
      releaseClaim = () => resolve(true)
    })
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben',
      // Why keyed on the claim's own cols: the subscribe handshake registers this stream's viewport
      // through the same method, and parking that would stall `subscribed` instead of the keystroke.
      runtimeOverrides: {
        updateRemoteDesktopViewer: vi.fn(
          (_ptyId: string, _key: string, _client: string, cols: number) =>
            cols === CLAIM_COLS ? claimed : Promise.resolve(true)
        ) as unknown as OrcaRuntimeService['updateRemoteDesktopViewer']
      }
    })

    sendClaimViewportFrame(ben.handlers, BEN_STREAM_ID)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()
    // Nobody was typing when the sync consult ran, so this keystroke is parked behind the claim.
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()
    expect(presenceResults(ben.messages).every((event) => !('arbitration' in event))).toBe(true)

    // Why Ben's own stamp is left to expire first: a keystroke parked this long is no longer typing, so
    // Ana's is an uncontested one — she arms the hold instead of being held for interrupting him.
    await settle(TERMINAL_PRESENCE_ACTIVITY_TTL_MS + 10)
    sendInputFrame(ana.handlers, 7, 'a')
    releaseClaim()
    await settle()

    // Why the second consult exists at all: the claim is async and the collision arrived underneath it.
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()
    expect(lastPresence(ben.messages)?.arbitration).toMatchObject({ heldFor: anaParticipantId })

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('never holds a second window of the grant that is typing', async () => {
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(SECOND_WINDOW_CONNECTION, GRANT, 'Ana laptop')
    const window1 = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana-1' })
    const window2 = await startNegotiatedMultiplex(SECOND_WINDOW_CONNECTION, GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ana-2'
    })

    sendInputFrame(window1.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(window2.handlers, BEN_STREAM_ID, 'b')
    await settle()

    // Keyed on the durable grant: A's two windows are two connections and one pairedDeviceId, so keying
    // on participantId here would hold a person against themselves.
    expect(sentTexts(window2.runtime)).toEqual(['b'])
    expect(presenceResults(window2.messages).every((event) => !('arbitration' in event))).toBe(true)

    vi.useRealTimers()
    window1.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    window2.cleanups.get(`terminal-multiplex:${SECOND_WINDOW_CONNECTION}`)?.()
    await Promise.all([window1.dispatchPromise, window2.dispatchPromise])
  })

  it('is a silent no-op while two humans share one grant, and bites once they do not', async () => {
    // Why this is the fence on the slice ordering: before S1 every peer of a runtime shared one pending
    // grant, so the self-check would swallow the gate and Q2 would look implemented while doing nothing.
    registerGrant(CONNECTION, GRANT, 'Shared link')
    registerGrant(SECOND_WINDOW_CONNECTION, GRANT, 'Shared link')
    const first = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'first' })
    const second = await startNegotiatedMultiplex(SECOND_WINDOW_CONNECTION, GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'second'
    })

    sendInputFrame(first.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(second.handlers, BEN_STREAM_ID, 'b')
    await settle()
    expect(sentTexts(second.runtime)).toEqual(['b'])

    // The same two keystrokes on two distinct grants — S1's always-mint world — are held.
    const distinctParticipantId = registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: 11,
      clientId: 'ben'
    })
    sendInputFrame(first.handlers, 7, 'a', 3)
    await settle(10)
    sendInputFrame(ben.handlers, 11, 'b')
    await settle()
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()
    expect(lastPresence(ben.messages)?.arbitration).toMatchObject({
      heldFor: expect.not.stringMatching(distinctParticipantId)
    })

    vi.useRealTimers()
    first.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    second.cleanups.get(`terminal-multiplex:${SECOND_WINDOW_CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([first.dispatchPromise, second.dispatchPromise, ben.dispatchPromise])
  })

  it('never holds a stream that did not negotiate presence', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben',
      presence: false
    })

    sendInputFrame(ana.handlers, 7, 'a')
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()

    // Why non-vacuous: the holder is provably typing on this PTY over this window, so the pass below is
    // the negotiation gate rather than an absent collision. Holding a client that cannot render the
    // reason would be an unexplained dropped keystroke, which is worse than the collision (§2.6).
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(
      participantRows(ana.messages).find((row) => row.participantId === anaParticipantId)
    ).toMatchObject({ typing: true })
    expect(sentTexts(ben.runtime)).toEqual(['b'])
    expect(presenceResults(ben.messages)).toEqual([])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('delivers a chat send while a desktop peer is typing', async () => {
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(CHAT_CONNECTION, CHAT_GRANT, 'Ben phone', 'mobile')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const phone = await startLeaseOnlySubscribe()

    sendInputFrame(ana.handlers, 7, 'a')
    await settle(10)
    await chatSend(phone.runtime, 'hello')

    // Site (d) is never HELD: a held terminal.send could only answer with a bare rejection, which says
    // nothing about why — worse than the collision it would prevent.
    expect(sentTexts(phone.runtime)).toEqual(['hello'])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    phone.cleanups.get('terminal-1:phone-1')?.()
    await Promise.all([ana.dispatchPromise, phone.dispatchPromise])
  })

  it('never arms a hold from a chat send, however fresh the grant write is', async () => {
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    const phoneParticipantId = registerGrant(CHAT_CONNECTION, CHAT_GRANT, 'Ben phone', 'mobile')
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const phone = await startLeaseOnlySubscribe()

    await chatSend(phone.runtime, 'hello')
    await settle(10)
    sendInputFrame(ana.handlers, 7, 'a')
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // Why non-vacuous: the phone's grant write is fresh and published on this very payload, so a
    // predicate that opened grantWrites would hold Ana here — the failure that would let an agent
    // borrowing a human's grant swallow another human's keystroke (§2.6).
    expect(
      participantRows(ana.messages).find((row) => row.participantId === phoneParticipantId)
    ).toMatchObject({ writing: true, typing: false })
    expect(presenceResults(ana.messages).every((event) => !('arbitration' in event))).toBe(true)
    expect(sentTexts(ana.runtime)).toEqual(['a'])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    phone.cleanups.get('terminal-1:phone-1')?.()
    await Promise.all([ana.dispatchPromise, phone.dispatchPromise])
  })

  it('lets the local human hold a remote peer once, naming the host participant', async () => {
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    // The exact call site (c) makes from the two IPC-guarded renderer writers.
    terminalPresenceRegistry.recordHostInteractiveInput(PRESENCE_PTY_ID)
    await settle(10)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()

    expect(lastPresence(ben.messages)?.arbitration).toEqual({
      heldFor: HOST_PARTICIPANT_ID,
      until: expect.any(Number)
    })
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()
    // Why the row matters as much as the notice: the chip renders "<label> is typing — press again" off
    // the participant the notice names, so a hold naming a row the payload lacks would render nothing.
    expect(participantRows(ben.messages).find((row) => row.kind === 'host')).toMatchObject({
      participantId: HOST_PARTICIPANT_ID,
      typing: true
    })

    vi.useRealTimers()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await ben.dispatchPromise
  })

  it('never holds the local human back after a peer types', async () => {
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben'
    })

    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()
    terminalPresenceRegistry.recordHostInteractiveInput(PRESENCE_PTY_ID)
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    // The host's keystroke enters through pty.ts IPC, which never consults the predicate at all — the
    // arbitration-reach test pins that omission at the source, and this is its behavioural half.
    expect(activeTerminalPresenceHoldNotice(PRESENCE_PTY_ID, HOST_PARTICIPANT_ID)).toBeNull()
    expect(presenceResults(ben.messages).every((event) => !('arbitration' in event))).toBe(true)
    expect(participantRows(ben.messages).find((row) => row.kind === 'host')).toMatchObject({
      typing: true
    })

    vi.useRealTimers()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await ben.dispatchPromise
  })
  it('spends no hold on a stream that can no longer receive the notice', async () => {
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    let releaseClaim = (): void => {}
    const claimed = new Promise<boolean>((resolve) => {
      releaseClaim = () => resolve(true)
    })
    const ana = await startNegotiatedMultiplex(CONNECTION, GRANT, { clientId: 'ana' })
    const ben = await startNegotiatedMultiplex(PEER_CONNECTION, PEER_GRANT, {
      streamId: BEN_STREAM_ID,
      clientId: 'ben',
      runtimeOverrides: {
        updateRemoteDesktopViewer: vi.fn(
          (_ptyId: string, _key: string, _client: string, cols: number) =>
            cols === CLAIM_COLS ? claimed : Promise.resolve(true)
        ) as unknown as OrcaRuntimeService['updateRemoteDesktopViewer']
      }
    })

    sendClaimViewportFrame(ben.handlers, BEN_STREAM_ID)
    sendInputFrame(ben.handlers, BEN_STREAM_ID, 'b')
    await settle()
    // The sibling case above is this one with the stream left alive: same park, same collision, held.
    await settle(TERMINAL_PRESENCE_ACTIVITY_TTL_MS + 10)
    sendInputFrame(ana.handlers, 7, 'a')
    sendUnsubscribeFrame(ben.handlers, BEN_STREAM_ID)
    releaseClaim()
    await settle()

    // The second consult found the stream detached, so the notice provably cannot land: nothing is held
    // and — the part an arm-then-check ordering got wrong — nothing is armed, so Ben's one nudge is still
    // his to spend on a stream that can render it.
    expect(activeTerminalPresenceHoldNotice(PRESENCE_PTY_ID, PEER_GRANT)).toBeNull()
    expect(presenceResults(ben.messages).every((event) => !('arbitration' in event))).toBe(true)
    // Fails open, as the gate does everywhere it cannot explain itself: the parked keystroke lands.
    expect(sentTexts(ben.runtime)).toEqual(['b'])

    vi.useRealTimers()
    ana.cleanups.get(`terminal-multiplex:${CONNECTION}`)?.()
    ben.cleanups.get(`terminal-multiplex:${PEER_CONNECTION}`)?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })
})

describe('terminal.subscribe soft arbitration', () => {
  it('holds a peer once on the phone-side handler and lets the re-press through', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')
    const ben = await startNegotiatedSubscribe(PEER_CONNECTION, PEER_GRANT, 'ben')

    sendInputFrame(ana.binaryHandlers, ana.streamId, 'a')
    await settle(10)
    sendInputFrame(ben.binaryHandlers, ben.streamId, 'b')
    await settle()

    expect(lastPresence(ben.messages)?.arbitration).toEqual({
      heldFor: anaParticipantId,
      until: expect.any(Number)
    })
    expect(ben.runtime.sendTerminal).not.toHaveBeenCalled()

    await settle(100)
    sendInputFrame(ben.binaryHandlers, ben.streamId, 'c', 3)
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    expect(sentTexts(ben.runtime)).toEqual(['c'])
    expect('arbitration' in (lastPresence(ben.messages) ?? {})).toBe(false)

    vi.useRealTimers()
    ana.cleanups.get('terminal-1:ana')?.()
    ben.cleanups.get('terminal-1:ben')?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('never holds a subscribe stream that did not negotiate presence', async () => {
    const anaParticipantId = registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')
    const ben = await startNegotiatedSubscribe(PEER_CONNECTION, PEER_GRANT, 'ben', false)

    sendInputFrame(ana.binaryHandlers, ana.streamId, 'a')
    await settle(10)
    sendInputFrame(ben.binaryHandlers, ben.streamId, 'b')
    await settle(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)

    expect(
      participantRows(ana.messages).find((row) => row.participantId === anaParticipantId)
    ).toMatchObject({ typing: true })
    expect(sentTexts(ben.runtime)).toEqual(['b'])
    expect(presenceResults(ben.messages)).toEqual([])

    vi.useRealTimers()
    ana.cleanups.get('terminal-1:ana')?.()
    ben.cleanups.get('terminal-1:ben')?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })

  it('spends no hold once its own stream is closed', async () => {
    registerGrant(CONNECTION, GRANT, 'Ana laptop')
    registerGrant(PEER_CONNECTION, PEER_GRANT, 'Ben laptop')
    const ana = await startNegotiatedSubscribe(CONNECTION, GRANT, 'ana')
    let releaseClaim = (): void => {}
    const claimed = new Promise<boolean>((resolve) => {
      releaseClaim = () => resolve(true)
    })
    const ben = startSubscribe(
      { connectionId: PEER_CONNECTION, pairedDeviceId: PEER_GRANT, clientKind: 'runtime' },
      {
        terminal: 'terminal-1',
        client: { id: 'ben', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, presence: 1, desktopViewportClaims: 1 }
      },
      new Map(),
      {
        updateRemoteDesktopViewer: vi.fn(
          (_ptyId: string, _key: string, _client: string, cols: number) =>
            cols === CLAIM_COLS ? claimed : Promise.resolve(true)
        ) as unknown as OrcaRuntimeService['updateRemoteDesktopViewer']
      }
    )
    const subscribed = await awaitSubscribed(ben.messages)
    const benStreamId = subscribed.streamId as number

    sendClaimViewportFrame(ben.binaryHandlers, benStreamId)
    sendInputFrame(ben.binaryHandlers, benStreamId, 'b')
    await settle()
    // Why Ben's own stamp is left to expire: a keystroke parked this long is no longer typing, so Ana's
    // is the uncontested one and the second consult is the only thing standing between it and a hold.
    await settle(TERMINAL_PRESENCE_ACTIVITY_TTL_MS + 10)
    sendInputFrame(ana.binaryHandlers, ana.streamId, 'a')
    ben.cleanups.get('terminal-1:ben')?.()
    releaseClaim()
    await settle()

    // Same rule as the multiplex helper: a stream that can no longer emit is never held and never arms,
    // so the nudge stays unspent instead of disarming the next stream this grant opens.
    expect(activeTerminalPresenceHoldNotice(PRESENCE_PTY_ID, PEER_GRANT)).toBeNull()
    expect(presenceResults(ben.messages).every((event) => !('arbitration' in event))).toBe(true)

    vi.useRealTimers()
    ana.cleanups.get('terminal-1:ana')?.()
    await Promise.all([ana.dispatchPromise, ben.dispatchPromise])
  })
})
