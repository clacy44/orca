// S10-21a C4 (Ruling 34 Addendum 9): resolveIncumbentDeath is pure — every case here is a plain
// evidence-bundle-in, verdict-out assertion; no runtime, no IO, no fake timers (the caller
// supplies `now`).
import { describe, expect, it } from 'vitest'
import { REBIND_SETTLE_MS, resolveIncumbentDeath, SettleObservations } from './incumbent-death'
import type { IncumbentEvidence } from './incumbent-death'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function baseEvidence(overrides: Partial<IncumbentEvidence> = {}): IncumbentEvidence {
  return {
    paneKey: PANE_KEY,
    ptyId: 'pty-1',
    d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
    d2: { inventory: 'present' },
    d3: { liveNow: true, firstObservedNotLiveAt: null, now: 1_000_000 },
    ...overrides
  }
}

describe('resolveIncumbentDeath', () => {
  // T4: live incumbent, connected — D1/D2/D3 all unsatisfied ⇒ no rebind.
  it('T4: all-alive evidence ⇒ not dead, reason live', () => {
    const verdict = resolveIncumbentDeath(baseEvidence())
    expect(verdict).toEqual({ dead: false, reason: 'live' })
  })

  // T4b: disconnected-but-alive incumbent — a transient inventory failure reads 'unknown', never
  // 'absent'; a successful round with the pty present also reads not dead.
  it("T4b: transient inventory failure ('unknown') ⇒ never dead, even when not currently live", () => {
    const evidence = baseEvidence({
      d2: { inventory: 'unknown' },
      d3: { liveNow: false, firstObservedNotLiveAt: null, now: 1_000_000 }
    })
    expect(resolveIncumbentDeath(evidence)).toEqual({ dead: false, reason: 'inventory_unknown' })
  })

  it('T4b: inventory succeeds with the pty present ⇒ not dead', () => {
    const evidence = baseEvidence({ d2: { inventory: 'present' } })
    expect(resolveIncumbentDeath(evidence).dead).toBe(false)
  })

  it('D1 alone ⇒ dead, signal D1 (absence from the runtime map is not enough by itself)', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: true },
      d2: { inventory: 'present' },
      d3: { liveNow: true, firstObservedNotLiveAt: null, now: 1_000_000 }
    })
    expect(resolveIncumbentDeath(evidence)).toMatchObject({ dead: true, signal: 'D1' })
  })

  it('ptyKnownToRuntime=false with no observed exit is NOT proof of D1 (a bad ptyId must not read dead)', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: false, exitObservedThisGeneration: false },
      d2: { inventory: 'present' },
      d3: { liveNow: true, firstObservedNotLiveAt: null, now: 1_000_000 }
    })
    expect(resolveIncumbentDeath(evidence).dead).toBe(false)
  })

  it('D2 alone ⇒ dead, signal D2', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
      d2: { inventory: 'absent' },
      d3: { liveNow: true, firstObservedNotLiveAt: null, now: 1_000_000 }
    })
    expect(resolveIncumbentDeath(evidence)).toMatchObject({ dead: true, signal: 'D2' })
  })

  it('D3 alone ⇒ dead once now - firstObservedNotLiveAt >= REBIND_SETTLE_MS, signal D3', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
      d2: { inventory: 'present' },
      d3: { liveNow: false, firstObservedNotLiveAt: 1_000_000, now: 1_000_000 + REBIND_SETTLE_MS }
    })
    expect(resolveIncumbentDeath(evidence)).toMatchObject({ dead: true, signal: 'D3' })
  })

  it('within the window ⇒ not dead (the latency bound: no signal is dead before its stated window)', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
      d2: { inventory: 'present' },
      d3: {
        liveNow: false,
        firstObservedNotLiveAt: 1_000_000,
        now: 1_000_000 + REBIND_SETTLE_MS - 1
      }
    })
    expect(resolveIncumbentDeath(evidence)).toEqual({ dead: false, reason: 'settling' })
  })

  it('all-alive ⇒ {dead:false}', () => {
    expect(resolveIncumbentDeath(baseEvidence()).dead).toBe(false)
  })

  it('no evidence at all (present inventory, never observed not-live) ⇒ insufficient_evidence, never dead', () => {
    const evidence = baseEvidence({
      d1: { ptyKnownToRuntime: true, exitObservedThisGeneration: false },
      d2: { inventory: 'present' },
      d3: { liveNow: false, firstObservedNotLiveAt: null, now: 1_000_000 }
    })
    expect(resolveIncumbentDeath(evidence)).toEqual({
      dead: false,
      reason: 'insufficient_evidence'
    })
  })
})

describe('SettleObservations', () => {
  it('records the first not-live timestamp and holds it across repeated not-live observations', () => {
    const clock = new SettleObservations()
    clock.observe(PANE_KEY, false, 100)
    clock.observe(PANE_KEY, false, 200)
    expect(clock.firstNotLiveAt(PANE_KEY)).toBe(100)
  })

  it('clears on a live observation', () => {
    const clock = new SettleObservations()
    clock.observe(PANE_KEY, false, 100)
    clock.observe(PANE_KEY, true, 150)
    expect(clock.firstNotLiveAt(PANE_KEY)).toBeNull()
  })

  it('forget() clears explicitly', () => {
    const clock = new SettleObservations()
    clock.observe(PANE_KEY, false, 100)
    clock.forget(PANE_KEY)
    expect(clock.firstNotLiveAt(PANE_KEY)).toBeNull()
  })

  it('a pane never observed reads null', () => {
    const clock = new SettleObservations()
    expect(clock.firstNotLiveAt(PANE_KEY)).toBeNull()
  })
})
