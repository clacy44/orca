import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPresenceRegistry } from './terminal-presence-registry'
import {
  TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
  buildTerminalPresenceActivityRows
} from './terminal-presence-activity-rows'
import {
  TERMINAL_PRESENCE_COALESCE_WINDOW_MS,
  createTerminalPresenceChangeNotifier,
  type TerminalPresenceChangeNotifier
} from './terminal-presence-change-notifier'

const PTY_ID = 'pty-1'
const ANA_KEY = 'stream:ana'
const BEN_KEY = 'stream:ben'

type Emit = { at: number; typing: Record<string, boolean> }

let registry: TerminalPresenceRegistry
let notifier: TerminalPresenceChangeNotifier

// Why one clock for the registry, the notifier and the assertion: the stamps, the TTL and the falling
// edge are one domain by design, and reading the rows off a second clock would let a drifted timer pass.
function attachPeers(): void {
  registry.registerConnection({
    connectionId: 'conn-ana',
    pairedDeviceId: 'grant-ana',
    label: 'Ana laptop',
    kind: 'runtime'
  })
  registry.registerConnection({
    connectionId: 'conn-ben',
    pairedDeviceId: 'grant-ben',
    label: 'Ben laptop',
    kind: 'runtime'
  })
  registry.attach(PTY_ID, ANA_KEY, 'conn-ana')
  registry.attach(PTY_ID, BEN_KEY, 'conn-ben')
}

function recordEmits(emits: Emit[]): () => void {
  return notifier.subscribe(PTY_ID, () => {
    const rows = buildTerminalPresenceActivityRows({
      registry,
      ptyId: PTY_ID,
      now: Date.now()
    })
    emits.push({
      at: Date.now(),
      typing: Object.fromEntries(rows.map((row) => [row.label, row.typing]))
    })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  registry = new TerminalPresenceRegistry()
  notifier = createTerminalPresenceChangeNotifier({ registry })
})

afterEach(() => {
  notifier.dispose()
  vi.useRealTimers()
})

describe('terminal presence falling edge', () => {
  it('clears each participant on its own expiry, not on the newest stamp', () => {
    attachPeers()
    const emits: Emit[] = []
    recordEmits(emits)
    const start = Date.now()

    registry.recordInteractiveInput(PTY_ID, ANA_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS / 2)
    registry.recordInteractiveInput(PTY_ID, BEN_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)

    // Why asserted at Ana's own +3000: arming off the freshest stamp publishes her as typing until Ben's
    // window closes 1.5 s later — a chip that outlives its own TTL with no emit to clear it.
    expect(emits.find((emit) => emit.at === start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS)).toEqual({
      at: start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
      typing: { 'Ana laptop': false, 'Ben laptop': true }
    })
    expect(
      emits.find((emit) => emit.at === start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 1.5)
    ).toEqual({
      at: start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 1.5,
      typing: { 'Ana laptop': false, 'Ben laptop': false }
    })
    expect(emits.at(-1)?.at).toBe(start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 1.5)
  })

  it('arms the falling edge for a subscriber that joins inside a live window', () => {
    attachPeers()
    const start = Date.now()

    // Why stamped with nobody listening: that is site (d)'s and the host's ordinary case — the registry
    // change is skipped for an unsubscribed PTY, so nothing is scheduled and the first payload a later
    // stream gets comes straight from its handler, bypassing this module entirely.
    registry.recordInteractiveInput(PTY_ID, ANA_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    const emits: Emit[] = []
    recordEmits(emits)

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)

    expect(emits).toEqual([
      {
        at: start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
        typing: { 'Ana laptop': false, 'Ben laptop': false }
      }
    ])
  })

  it('keeps one expiry emit when a second stream joins the same PTY', () => {
    attachPeers()
    const start = Date.now()
    registry.recordInteractiveInput(PTY_ID, ANA_KEY)
    const emits: Emit[] = []
    recordEmits(emits)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_COALESCE_WINDOW_MS)
    const settled = emits.length

    // Why exactly two entries and not four: one expiry emit reaching both listeners. Arming without
    // clearing strands the first timer and fires the whole fan-out twice at the same deadline.
    recordEmits(emits)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)

    expect(emits.slice(settled).map((emit) => emit.at)).toEqual([
      start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS,
      start + TERMINAL_PRESENCE_ACTIVITY_TTL_MS
    ])
  })

  it('arms nothing for a PTY whose only stamps have already expired', () => {
    attachPeers()
    registry.recordInteractiveInput(PTY_ID, ANA_KEY)
    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS)
    const emits: Emit[] = []
    recordEmits(emits)

    vi.advanceTimersByTime(TERMINAL_PRESENCE_ACTIVITY_TTL_MS * 2)

    expect(emits).toEqual([])
  })
})
