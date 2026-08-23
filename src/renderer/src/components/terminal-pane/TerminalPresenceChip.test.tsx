import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TerminalPresenceParticipant } from '@/lib/pane-manager/terminal-presence-state'
import { i18n } from '@/i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '@/i18n/pseudo-localization'
import { TerminalPresenceChip } from './TerminalPresenceChip'
import { resolveTerminalPresenceChipState } from './terminal-presence-chip-state'

function peer(overrides: Partial<TerminalPresenceParticipant> = {}): TerminalPresenceParticipant {
  return {
    participantId: 'p-peer',
    label: 'Ana laptop',
    kind: 'runtime',
    self: false,
    typing: false,
    writing: false,
    since: 1,
    ...overrides
  }
}

function renderChip(
  participants: TerminalPresenceParticipant[],
  arbitration: { heldFor: string; until: number } | null = null
): string {
  return renderToStaticMarkup(
    <TerminalPresenceChip state={resolveTerminalPresenceChipState({ participants, arbitration })} />
  )
}

describe('TerminalPresenceChip', () => {
  it('renders the four states through the presence ladder', () => {
    expect(renderChip([peer()])).toContain('In use by Ana laptop')
    expect(renderChip([peer({ writing: true })])).toContain('Ana laptop is writing')
    expect(renderChip([peer({ typing: true })])).toContain('Ana laptop is typing')
    expect(renderChip([peer({ typing: true })], { heldFor: 'p-peer', until: 5000 })).toContain(
      'Ana laptop is typing — press again'
    )
  })

  it('names a typing peer over a writing one', () => {
    const markup = renderChip([
      peer({ participantId: 'p-writer', label: 'Ben phone', kind: 'mobile', writing: true }),
      peer({ participantId: 'p-typist', label: 'Ana laptop', typing: true })
    ])

    expect(markup).toContain('Ana laptop is typing')
    expect(markup).not.toContain('Ben phone')
  })

  it('carries no take-back affordance and never intercepts pointer events', () => {
    const markup = renderChip([peer({ typing: true })])

    expect(markup).not.toContain('<button')
    expect(markup).toContain('pointer-events-none')
    expect(markup).toContain('data-presence-activity="typing"')
  })

  it('renders nothing when the reader is the only participant', () => {
    expect(renderChip([peer({ participantId: 'p-self', self: true, typing: true })])).toBe('')
  })

  it('renders the staleness copy with elapsed minutes', () => {
    const markup = renderChip([
      peer({
        kind: 'mobile',
        label: "Ben's phone",
        stale: true,
        lastSeenAt: Date.now() - 4 * 60_000
      })
    ])
    expect(markup).toContain('Ben&#x27;s phone attached · last seen 4m ago')
    expect(markup).toContain('data-presence-activity="stale"')
    expect(markup).not.toContain('typing')
  })

  describe('the lane account segment (S9 §2k)', () => {
    it('renders the owner, the account name and the bar beside the presence copy', () => {
      const markup = renderToStaticMarkup(
        <TerminalPresenceChip state={null} lane={{ label: 'Ana · work', usedPercent: 74 }} />
      )

      expect(markup).toContain('Ana · work · 74%')
    })

    it('renders the label with no percentage when the bar is omitted for a peer', () => {
      const markup = renderToStaticMarkup(
        <TerminalPresenceChip state={null} lane={{ label: 'Ana · work' }} />
      )

      expect(markup).toContain('Ana · work')
      expect(markup).not.toContain('%')
    })

    it('says why the bar is missing rather than rendering a stale one', () => {
      const markup = renderToStaticMarkup(
        <TerminalPresenceChip
          state={null}
          lane={{ label: 'Ana', unavailableReason: 'pull-unsupported-on-host' }}
        />
      )

      expect(markup).toContain('Ana · usage unavailable on this host')
    })

    // The host sends a CODE; the sentence is this client's. Under the pseudo locale a string that
    // skipped `translate` stays bare ASCII, so this discriminates the two implementations.
    it('routes both lane strings through i18n rather than interpolating them raw', async () => {
      const previous = i18n.language
      await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
      try {
        expect(
          renderToStaticMarkup(
            <TerminalPresenceChip
              state={null}
              lane={{ label: 'Ana', unavailableReason: 'pull-unsupported-on-host' }}
            />
          )
        ).toContain('[Ana · usage unavailable on this host]')
        expect(
          renderToStaticMarkup(
            <TerminalPresenceChip state={null} lane={{ label: 'Ana', usedPercent: 61 }} />
          )
        ).toContain('[Ana · 61%]')
      } finally {
        await i18n.changeLanguage(previous)
      }
    })

    it('still renders nothing when neither presence nor a lane row is present', () => {
      expect(renderToStaticMarkup(<TerminalPresenceChip state={null} />)).toBe('')
    })
  })
})
