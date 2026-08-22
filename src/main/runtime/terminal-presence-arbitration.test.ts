import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_PRESENCE_ACTIVITY_TTL_MS } from './terminal-presence-activity-rows'
import {
  ARBITRATION_REPROMPT_MS,
  createTerminalPresenceArbitration,
  type TerminalPresenceArbitration
} from './terminal-presence-arbitration'
import { TerminalPresenceRegistry } from './terminal-presence-registry'
import { HOST_PARTICIPANT_ID } from './terminal-presence-snapshot'

const PTY_ID = 'pty-1'
const ANA_GRANT = 'device-ana'
const BEN_GRANT = 'device-ben'

let clock = 1_000
let registry: TerminalPresenceRegistry
let arbitration: TerminalPresenceArbitration

function participantIdOf(pairedDeviceId: string, connectionId: string, label: string): string {
  return registry.registerConnection({
    connectionId,
    pairedDeviceId,
    label,
    kind: 'runtime'
  }).participantId
}

function typeOn(connectionId: string, subscriptionKey: string): void {
  registry.attach(PTY_ID, subscriptionKey, connectionId)
  registry.recordInteractiveInput(PTY_ID, subscriptionKey)
}

beforeEach(() => {
  clock = 1_000
  registry = new TerminalPresenceRegistry({ now: () => clock })
  arbitration = createTerminalPresenceArbitration({ registry })
})

describe('shouldHoldInputForTypingPeer', () => {
  it('holds a peer once and lets the re-press through inside the window', () => {
    const anaId = participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    participantIdOf(BEN_GRANT, 'conn-ben', 'Ben laptop')
    typeOn('conn-ana', 'stream:ana')

    clock += 10
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toEqual({
      heldFor: anaId,
      until: clock + ARBITRATION_REPROMPT_MS
    })
    expect(arbitration.activeHoldNotice(PTY_ID, BEN_GRANT)).toEqual({
      heldFor: anaId,
      until: clock + ARBITRATION_REPROMPT_MS
    })

    clock += 100
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    // Why the notice goes with the re-press: the client is told its keystroke landed by the field
    // disappearing, so a released hold that kept publishing would leave "press again" on screen.
    expect(arbitration.activeHoldNotice(PTY_ID, BEN_GRANT)).toBeNull()
  })

  it('re-consulting for one keystroke never holds the input the first consult released', () => {
    // Why: §2.6 consults the predicate twice per keystroke — once synchronously and once inside the
    // async claim tail — so a predicate that cleared its record on the re-press would drop the very
    // keystroke that just earned its way through.
    const anaId = participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toMatchObject({
      heldFor: anaId
    })

    clock += 20
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
  })

  it('nudges once per typing episode however long the peer keeps typing', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()

    for (let keystroke = 0; keystroke < 20; keystroke += 1) {
      clock += 100
      registry.recordInteractiveInput(PTY_ID, 'stream:ana')
      expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    }
  })

  it('nudges again once the held peer has been silent past the re-press window', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()

    // Why not spam: the prompt lapsed unanswered and the client cleared it, so a peer coming back to a
    // keyboard somebody else is still using is told why their keystroke did not land.
    clock += ARBITRATION_REPROMPT_MS
    registry.recordInteractiveInput(PTY_ID, 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()
  })

  it('never holds a second window of the grant that is typing', () => {
    // The self-check keys on the DURABLE grant: one peer's two windows are two connections and one
    // pairedDeviceId, so keying on participantId here would hold a person against themselves.
    participantIdOf(ANA_GRANT, 'conn-ana-1', 'Ana laptop')
    participantIdOf(ANA_GRANT, 'conn-ana-2', 'Ana laptop')
    typeOn('conn-ana-1', 'stream:ana-1')
    registry.attach(PTY_ID, 'stream:ana-2', 'conn-ana-2')

    clock += 10
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, ANA_GRANT)).toBeNull()
    // Non-vacuous: the same typing stamp holds anybody on a different grant.
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()
  })

  it('lets a keystroke through once the peer falls outside the typing TTL', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')

    clock += TERMINAL_PRESENCE_ACTIVITY_TTL_MS - 1
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()

    clock += 1
    // Why cleared rather than merely passed: the episode is over, so the next collision must be able to
    // nudge instead of inheriting this spent record.
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    expect(arbitration.activeHoldNotice(PTY_ID, BEN_GRANT)).toBeNull()
    registry.recordInteractiveInput(PTY_ID, 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()
  })

  it('arms on the local human and names the host participant', () => {
    participantIdOf(BEN_GRANT, 'conn-ben', 'Ben laptop')
    registry.recordHostInteractiveInput(PTY_ID)

    clock += 10
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toEqual({
      heldFor: HOST_PARTICIPANT_ID,
      until: clock + ARBITRATION_REPROMPT_MS
    })
  })

  it('never arms on a grant write, however fresh', () => {
    // The mutation this fences: a predicate that opened grantWrites would let an agent borrowing a
    // human's grant swallow another human's keystroke — the worst failure this design could ship.
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    registry.attach(PTY_ID, 'lease:ana', 'conn-ana')
    registry.recordGrantWrite(PTY_ID, ANA_GRANT)

    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    // Non-vacuous: the same attachment holds the moment it carries an INTERACTIVE stamp instead.
    registry.recordInteractiveInput(PTY_ID, 'lease:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()
  })

  it('ignores a typing attachment whose connection resolves to no participant', () => {
    typeOn('conn-ghost', 'stream:ghost')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
  })

  it('never counters the incumbent typist with the keystroke it just held', () => {
    // The failure this fences: both handlers stamp BEFORE consulting the gate (§4.5), so a held peer is
    // still published as typing — and a symmetric predicate reads that stamp as a collision and drops the
    // incumbent's next keystroke too. Both humans lose a character on every ordinary two-person collision.
    const anaId = participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    const benId = participantIdOf(BEN_GRANT, 'conn-ben', 'Ben laptop')
    typeOn('conn-ana', 'stream:ana')

    clock += 10
    typeOn('conn-ben', 'stream:ben')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toMatchObject({
      heldFor: anaId
    })

    clock += 10
    registry.recordInteractiveInput(PTY_ID, 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, ANA_GRANT)).toBeNull()

    // Non-vacuous: Ben's re-press lands, so his typing is real again and Ana pays her own single bump.
    clock += 10
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    registry.recordInteractiveInput(PTY_ID, 'stream:ben')
    clock += 10
    registry.recordInteractiveInput(PTY_ID, 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, ANA_GRANT)).toMatchObject({
      heldFor: benId
    })
  })

  it('keeps no record for a hold that already lapsed', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).not.toBeNull()

    clock += ARBITRATION_REPROMPT_MS
    expect(arbitration.activeHoldNotice(PTY_ID, BEN_GRANT)).toBeNull()
  })
})

describe('nextHoldExpiryAt', () => {
  it('names the deadline the falling edge owes a notice, and nothing once it is retired', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    expect(arbitration.nextHoldExpiryAt(PTY_ID)).toBeNull()

    clock += 10
    const held = arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)
    expect(arbitration.nextHoldExpiryAt(PTY_ID)).toBe(held?.until)

    // Why nothing after the re-press: that keystroke mutated the registry, so the emit dropping the
    // notice already rides the coalescer — only the unanswered window needs an emit of its own.
    clock += 10
    expect(arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)).toBeNull()
    expect(arbitration.nextHoldExpiryAt(PTY_ID)).toBeNull()
  })

  it('stops naming a deadline the moment it is met, so its own emit arms nothing further', () => {
    participantIdOf(ANA_GRANT, 'conn-ana', 'Ana laptop')
    typeOn('conn-ana', 'stream:ana')
    const held = arbitration.shouldHoldInputForTypingPeer(PTY_ID, BEN_GRANT)!

    clock = held.until - 1
    expect(arbitration.nextHoldExpiryAt(PTY_ID)).toBe(held.until)
    clock = held.until
    expect(arbitration.nextHoldExpiryAt(PTY_ID)).toBeNull()
  })
})

describe('arbitration reach', () => {
  it('is wired at the two live stream handlers and nowhere else', () => {
    // Why source-level: "the host is never held" and "site (d) is never held" are code-level omissions
    // (§2.6) — pty.ts has no negotiated stream to carry a "press again" notice and terminal.send could
    // only answer with a bare rejection, so both must never reach this module. A behavioural test can
    // only observe the absence; this pins the reason.
    const root = join(import.meta.dirname, '..')
    for (const file of ['ipc/pty.ts', 'runtime/orca-runtime.ts']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain('terminal-presence-arbitration')
    }
  })

  it('reads no platform-dependent state', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'terminal-presence-arbitration.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/os\.platform|process\.platform|node:path/)
  })
})
