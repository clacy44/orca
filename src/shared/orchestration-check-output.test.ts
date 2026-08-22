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
