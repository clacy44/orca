import { describe, expect, it } from 'vitest'
import {
  decodeMobileTerminalPresence,
  summarizeMobileTerminalPresence,
  type MobileTerminalPresenceRow
} from './mobile-terminal-presence'

function row(overrides: Partial<MobileTerminalPresenceRow> = {}): MobileTerminalPresenceRow {
  return {
    participantId: 'p-ana',
    label: 'Ana laptop',
    kind: 'runtime',
    self: false,
    typing: false,
    writing: false,
    ...overrides
  }
}

describe('decodeMobileTerminalPresence', () => {
  it('reads a well-formed presence event', () => {
    expect(
      decodeMobileTerminalPresence({
        type: 'terminal-presence',
        streamId: 3,
        participants: [row()]
      })
    ).toEqual([row()])
  })

  // Degradation, both directions: an older host sends none of this, and a newer one may send an event
  // type this build has never heard of. Either way the screen must be left exactly as it was.
  it('ignores every other stream event, including unknown types', () => {
    expect(decodeMobileTerminalPresence({ type: 'data', chunk: 'x' })).toBeNull()
    expect(decodeMobileTerminalPresence({ type: 'subscribed', streamId: 1 })).toBeNull()
    expect(decodeMobileTerminalPresence({ type: 'terminal-something-new' })).toBeNull()
    expect(decodeMobileTerminalPresence(undefined)).toBeNull()
    expect(decodeMobileTerminalPresence('terminal-presence')).toBeNull()
  })

  it('drops the whole roster rather than render a partial one', () => {
    expect(
      decodeMobileTerminalPresence({
        type: 'terminal-presence',
        participants: [row(), { participantId: 'p-x' }]
      })
    ).toBeNull()
    expect(decodeMobileTerminalPresence({ type: 'terminal-presence' })).toBeNull()
  })

  // The comment above the decoder says extra keys are tolerated so a newer host can add fields without a
  // mobile release. A new `kind` VALUE has to degrade the same way, or the all-or-nothing rule turns an
  // additive host change into a blank banner on a phone that cannot be respun to catch up.
  it('renders a row whose kind this build has never heard of', () => {
    const decoded = decodeMobileTerminalPresence({
      type: 'terminal-presence',
      participants: [row(), { ...row({ participantId: 'p-new', label: 'kiosk' }), kind: 'kiosk' }]
    })
    expect(decoded).toHaveLength(2)
    expect(summarizeMobileTerminalPresence(decoded ?? [])).toBe('Ana laptop attached +1')
  })

  it('keeps fields a newer host adds', () => {
    const decoded = decodeMobileTerminalPresence({
      type: 'terminal-presence',
      participants: [{ ...row(), somethingNew: 7 }]
    })
    expect(decoded).toHaveLength(1)
    expect(decoded?.[0]?.label).toBe('Ana laptop')
  })
})

describe('summarizeMobileTerminalPresence', () => {
  it('says nothing when the reader is alone', () => {
    expect(summarizeMobileTerminalPresence([])).toBeNull()
    expect(
      summarizeMobileTerminalPresence([row({ participantId: 'p-me', self: true, typing: true })])
    ).toBeNull()
  })

  it('names the loudest peer on the same ladder the desktop chip uses', () => {
    expect(summarizeMobileTerminalPresence([row()])).toBe('Ana laptop attached')
    expect(summarizeMobileTerminalPresence([row({ writing: true })])).toBe('Ana laptop is writing')
    expect(summarizeMobileTerminalPresence([row({ typing: true, writing: true })])).toBe(
      'Ana laptop is typing'
    )
    expect(
      summarizeMobileTerminalPresence([
        row({ participantId: 'p-quiet', label: 'devbox', kind: 'host' }),
        row({ typing: true })
      ])
    ).toBe('Ana laptop is typing +1')
  })

  it('reports another phone as attached with how long ago it was last seen', () => {
    expect(
      summarizeMobileTerminalPresence(
        [
          row({
            participantId: 'p-ben',
            label: "Ben's phone",
            kind: 'mobile',
            stale: true,
            lastSeenAt: 1_000
          })
        ],
        1_000 + 4 * 60_000
      )
    ).toBe("Ben's phone attached, last seen 4m ago")
  })

  // The two fields are independent optionals on the wire, and the phone has no liveness signal of its
  // own — so a flag with no stamp reads as plain "attached" rather than a duration this build invented.
  it('says plain attached for a stale row that carries no stamp', () => {
    expect(
      summarizeMobileTerminalPresence(
        [row({ participantId: 'p-ben', label: "Ben's phone", kind: 'mobile', stale: true })],
        1_000 + 4 * 60_000
      )
    ).toBe("Ben's phone attached")
  })
})
