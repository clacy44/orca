// No pre-existing test file covered formatOrchestrationSent (grep confirmed: only
// orchestration-sent-format.ts and src/cli/handlers/orchestration.ts reference it, neither a
// .test.ts) — S10-15 verifier V-6 asked to "extend its existing test"; since none exists, this
// file is created fresh rather than skipped, per the fast-worker brief's "if underspecified,
// report the deviation rather than skipping."
import { describe, expect, it } from 'vitest'
import { formatOrchestrationSent } from './orchestration-sent-format'
import type { OrchestrationSentResult } from '../shared/orchestration-delivery-state'

describe('formatOrchestrationSent', () => {
  it('reports a plain queued state with no environment line', () => {
    const result: OrchestrationSentResult = {
      delivery: { state: 'queued', recipient: { state: 'unresolved', lastSeenAt: null } }
    }
    const out = formatOrchestrationSent(result, 'msg_1', 'orca')
    expect(out).toBe(
      'msg_1: queued (recipient not currently resolvable).\n' +
        'Next step: orca orchestration sent --id msg_1 --json — check again for a state change.'
    )
    expect(out).not.toContain('environment:')
  })

  it('reports read with no next-step line and no environment line', () => {
    const result: OrchestrationSentResult = {
      delivery: { state: 'read', recipient: { state: 'unresolved', lastSeenAt: null } }
    }
    const out = formatOrchestrationSent(result, 'msg_2', 'orca')
    expect(out).toBe('msg_2: read (recipient not currently resolvable).')
    expect(out).not.toContain('environment:')
  })

  // V-6: print `environment` when the snapshot carries it — the relay states are exactly the
  // ones that set it (message-delivery-state.ts / orca-runtime.ts's getMessageDeliverySnapshot).
  it('V-6: prints an environment line for a relay_pending row', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relay_pending',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1'
      }
    }
    const out = formatOrchestrationSent(result, 'msg_3', 'orca')
    expect(out).toBe(
      'msg_3: relay_pending (recipient not currently resolvable).\n' +
        'environment: env_windows_1\n' +
        'Next step: orca orchestration sent --id msg_3 --json — check again for a state change.'
    )
  })

  it('V-6: prints an environment line for a relayed row', () => {
    const result: OrchestrationSentResult = {
      delivery: {
        state: 'relayed',
        recipient: { state: 'unresolved', lastSeenAt: null },
        environment: 'env_windows_1'
      }
    }
    const out = formatOrchestrationSent(result, 'msg_4', 'orca')
    expect(out).toBe(
      'msg_4: relayed (recipient not currently resolvable).\n' +
        'environment: env_windows_1\n' +
        'Next step: orca orchestration sent --id msg_4 --json — check again for a state change.'
    )
  })

  // S10-16 C6, plan §C6 file table: "the formatter falls back to printing the raw string rather
  // than throwing on an unknown state." Already true by construction — the ternary at
  // orchestration-sent-format.ts:13-16 has no exhaustive switch to fall through, so any state
  // this union doesn't yet name (a future outbox state on an old CLI) prints verbatim instead of
  // throwing. This test pins that property rather than asserting a code change.
  it('prints an unrecognized delivery state verbatim instead of throwing', () => {
    const result = {
      delivery: {
        state: 'some_future_state',
        recipient: { state: 'unresolved', lastSeenAt: null }
      }
    } as unknown as OrchestrationSentResult
    expect(() => formatOrchestrationSent(result, 'msg_5', 'orca')).not.toThrow()
    expect(formatOrchestrationSent(result, 'msg_5', 'orca')).toContain('some_future_state')
  })
})
