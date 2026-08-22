import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type OrchestrationCheckOutput
} from './orchestration-check-output'

describe('prepareOrchestrationCheckOutput', () => {
  it('keeps mixed read-only mail safe and current Run replies executable', () => {
    const prepared = prepareOrchestrationCheckOutput(
      {
        count: 2,
        messages: [
          {
            id: 'msg_current',
            run_id: 'run_adopted',
            delivery_contract: 'current_delivery',
            from_handle: 'term_worker',
            to_handle: 'run:run_adopted',
            subject: 'Question'
          },
          {
            id: 'msg_legacy',
            run_id: 'run_legacy_local',
            delivery_contract: 'audit_only',
            from_handle: 'term_legacy',
            to_handle: 'term_coord',
            subject: 'Old reply'
          }
        ],
        formatted: '[Reply: unsafe stale formatter output]'
      },
      'term_current_coord',
      true
    )

    expect(prepared.formatted).toContain(
      '[Reply: orca orchestration reply --id msg_current --body "..."]'
    )
    expect(prepared.formatted).not.toContain('--from run:run_adopted')
    expect(prepared.formatted).toContain(
      '[Inspection only: reply and acknowledgment are unavailable.]'
    )
    expect(prepared.formatted).not.toContain('unsafe stale formatter output')
  })
})

describe('formatOrchestrationCheckText waitInterrupted', () => {
  const interrupted = (
    extra: Partial<OrchestrationCheckOutput> = {}
  ): OrchestrationCheckOutput => ({
    messages: [],
    count: 0,
    runId: 'run_1',
    timedOut: false,
    cancelled: false,
    ...extra
  })

  it('names the replaced consumer and how to rebind', () => {
    expect(
      formatOrchestrationCheckText(
        interrupted({ waitInterrupted: 'consumer_fenced' }),
        'term_coord'
      )
    ).toBe(
      'Wait ended: this mailbox consumer was replaced. Rebind with: orca orchestration run-use --id run_1'
    )
  })

  it('falls back to a placeholder when the host sent no runId', () => {
    expect(
      formatOrchestrationCheckText(
        { ...interrupted({ waitInterrupted: 'consumer_fenced' }), runId: undefined },
        'term_coord'
      )
    ).toContain('run-use --id <runId>')
  })

  it('says another waiter owns the Run', () => {
    expect(
      formatOrchestrationCheckText(interrupted({ waitInterrupted: 'waiter_exists' }), 'term_coord')
    ).toBe(
      "Wait ended: another actionable waiter already owns this Run's mailbox; only one can block on it at a time."
    )
  })

  it('says the acknowledgement landed but the outcome is unknown', () => {
    expect(
      formatOrchestrationCheckText(
        interrupted({ waitInterrupted: 'outcome_unknown' }),
        'term_coord'
      )
    ).toBe(
      "Wait ended: this check acknowledged its Delivery but the wait's outcome is unknown. Re-run check to see the current mailbox."
    )
  })

  it('still prints exactly No messages. for a genuinely empty mailbox', () => {
    expect(formatOrchestrationCheckText(interrupted(), 'term_coord')).toBe('No messages.')
  })

  it('keeps the timed-out wording when a wait simply expired', () => {
    expect(formatOrchestrationCheckText(interrupted({ timedOut: true }), 'term_coord')).toBe(
      'Wait timed out; no messages were consumed.'
    )
  })

  it('keeps the cancelled wording', () => {
    expect(formatOrchestrationCheckText(interrupted({ cancelled: true }), 'term_coord')).toBe(
      'Wait cancelled; no messages were consumed.'
    )
  })
})

describe('formatOrchestrationCheckText delivery replay', () => {
  const delivered = (extra: Partial<OrchestrationCheckOutput>): OrchestrationCheckOutput => ({
    deliveryId: 'delivery_1',
    count: 1,
    messages: [
      {
        id: 'msg_1',
        run_id: 'run_1',
        delivery_contract: 'current_delivery',
        from_handle: 'term_worker',
        to_handle: 'run:run_1',
        subject: 'progress',
        type: 'status'
      }
    ],
    ...extra
  })

  it('names how many newer messages a replay is blocking', () => {
    expect(
      formatOrchestrationCheckText(delivered({ replayed: true, pendingBehind: 3 }), 'term_coord')
    ).toContain(
      'Delivery delivery_1 [REPLAY — 3 newer messages are blocked behind it; acknowledge with --ack delivery_1]'
    )
  })

  it('still marks a replay that is blocking nothing', () => {
    expect(
      formatOrchestrationCheckText(delivered({ replayed: true, pendingBehind: 0 }), 'term_coord')
    ).toContain('Delivery delivery_1 [REPLAY — acknowledge with --ack delivery_1]')
  })

  it('leaves a fresh Delivery line exactly as it was', () => {
    expect(
      formatOrchestrationCheckText(delivered({ replayed: false, pendingBehind: 0 }), 'term_coord')
    ).toContain('Delivery delivery_1\n')
  })

  it('renders an older host with no replay fields exactly as before', () => {
    expect(formatOrchestrationCheckText(delivered({}), 'term_coord')).toContain(
      'Delivery delivery_1\n'
    )
  })

  it('names the remainder a capped fresh batch already left behind', () => {
    expect(
      formatOrchestrationCheckText(delivered({ replayed: false, pendingBehind: 5 }), 'term_coord')
    ).toContain(
      'Delivery delivery_1 [5 more queued behind this batch; acknowledge with --ack delivery_1]'
    )
  })

  it('keeps the replay marker on the --format and --inject path', () => {
    const rendered = formatOrchestrationCheckText(
      delivered({ replayed: true, pendingBehind: 3, formatted: '[FROM term_worker] progress' }),
      'term_coord'
    )

    expect(rendered).toBe(
      'Delivery delivery_1 [REPLAY — 3 newer messages are blocked behind it; acknowledge with --ack delivery_1]\n[FROM term_worker] progress'
    )
  })

  it('renders a fresh formatted Delivery byte-identically to today', () => {
    expect(
      formatOrchestrationCheckText(
        delivered({ replayed: false, pendingBehind: 0, formatted: '[FROM term_worker] progress' }),
        'term_coord'
      )
    ).toBe('[FROM term_worker] progress')
  })

  it('leaves a formatted peek with no Delivery untouched', () => {
    expect(
      formatOrchestrationCheckText(
        { count: 1, messages: [], formatted: '[FROM term_worker] progress' },
        'term_coord'
      )
    ).toBe('[FROM term_worker] progress')
  })
})
