// [G1 B2] Unit tests for canAttemptUnobservedStarvationEscape — one per guard, each with its own
// mutant proof (comment records the manual mutant run; see the lane return for verbatim tails).
// The suite-level i24-delivery-escape.test.ts pins the guards through the full async runtime;
// these tests pin the pure decision function directly, so a guard regression fails here even if
// some other guard in the runtime's own wiring happens to mask it in the integration suite.
import { describe, expect, it } from 'vitest'
import {
  canAttemptUnobservedStarvationEscape,
  hasClaudeHookSinceFenceExpiry,
  hasEscapedRecently,
  type ClaudeHookSnapshotEntry,
  type UnobservedStarvationEscapeGuardInput
} from './unobserved-delivery-escape'

const NOW = 1_000_000_000
const BOUND_MS = 10 * 60_000
const PANE_KEY = 'tab-1:leaf-1'

function doneHook(receivedAt: number): ClaudeHookSnapshotEntry {
  return { paneKey: PANE_KEY, agentType: 'claude', state: 'done', receivedAt }
}

/** Every guard held — (a)-(d), (g) — the smallest input that returns true. */
function baseInput(): UnobservedStarvationEscapeGuardInput {
  return {
    now: NOW,
    starvation: { firstAt: NOW - BOUND_MS - 1, at: NOW, count: 1, reason: 'no_hydrated_status' },
    starvationBoundMs: BOUND_MS,
    generationStartedAt: NOW - BOUND_MS - 1,
    ptyConnected: true,
    fenceHolds: false,
    fenceExpiredWithoutEvidenceAt: undefined,
    paneKey: PANE_KEY,
    claudeHooks: [doneHook(NOW - BOUND_MS - 1)]
  }
}

describe('canAttemptUnobservedStarvationEscape: the base fixture itself passes', () => {
  it('every guard held returns true', () => {
    expect(canAttemptUnobservedStarvationEscape(baseInput())).toBe(true)
  })
})

describe('guard (a): starvation bound, measured from max(firstAt, generationStartedAt)', () => {
  it('no starvation record at all refuses', () => {
    expect(canAttemptUnobservedStarvationEscape({ ...baseInput(), starvation: undefined })).toBe(
      false
    )
  })

  it('starvation record not yet crossed the bound refuses', () => {
    const input = {
      ...baseInput(),
      starvation: { firstAt: NOW - BOUND_MS + 1, at: NOW, count: 1, reason: 'no_hydrated_status' }
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  // [G1 B3] The fix itself: an OLD starvation record (crossed the bound by its own firstAt)
  // must NOT authorize a write into a generation that started AFTER that firstAt and has not
  // itself been starved for the full bound yet — a main restart or same-id respawn scenario.
  it('an old starvation record against a freshly-started generation refuses (G1 B3 mutant target)', () => {
    const input = {
      ...baseInput(),
      starvation: { firstAt: NOW - BOUND_MS - 1, at: NOW, count: 1, reason: 'no_hydrated_status' },
      generationStartedAt: NOW - 1 // generation started 1ms ago — nowhere near the bound.
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('undefined generationStartedAt does not add a restriction beyond starvation.firstAt', () => {
    const input = { ...baseInput(), generationStartedAt: undefined }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(true)
  })
  // MUTANT PROOF (guard a): reverting to `hasCrossedBound(input.starvation, input.now,
  // input.starvationBoundMs)` (dropping the generationStartedAt max) makes the "freshly-started
  // generation" test above fail — verified manually against 8fa8837039's own guard (a); see the
  // lane return for the verbatim tail.
})

describe('guard (b): pty connected, launch-prompt fence not holding', () => {
  it('pty not connected refuses', () => {
    expect(canAttemptUnobservedStarvationEscape({ ...baseInput(), ptyConnected: false })).toBe(
      false
    )
  })

  it('fence holds refuses', () => {
    expect(canAttemptUnobservedStarvationEscape({ ...baseInput(), fenceHolds: true })).toBe(false)
  })
  // MUTANT PROOF (guard b): deleting `if (!input.ptyConnected || input.fenceHolds) return false`
  // makes both tests above return true instead of false.
})

describe('guard (c): an evidence-less fence expiry must clear before the escape may fire', () => {
  it('an outstanding evidence-less expiry with no qualifying hook since refuses', () => {
    const input = {
      ...baseInput(),
      fenceExpiredWithoutEvidenceAt: NOW - 1000,
      claudeHooks: [doneHook(NOW - 2000)] // Before the expiry — does not clear it.
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('a qualifying hook received AT/AFTER the expiry clears it and the escape may fire', () => {
    const input = {
      ...baseInput(),
      fenceExpiredWithoutEvidenceAt: NOW - 2000,
      claudeHooks: [doneHook(NOW - 1000)]
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(true)
  })

  it('hasClaudeHookSinceFenceExpiry is exported and agrees with the guard', () => {
    expect(hasClaudeHookSinceFenceExpiry([doneHook(NOW - 1000)], PANE_KEY, NOW - 2000)).toBe(true)
    expect(hasClaudeHookSinceFenceExpiry([doneHook(NOW - 2000)], PANE_KEY, NOW - 1000)).toBe(false)
  })
  // MUTANT PROOF (guard c): deleting the `fenceExpiredWithoutEvidenceAt !== undefined && ...`
  // branch makes the first test above return true instead of false.
})

describe('guard (d): the newest Claude hook of any age must not be waiting/blocked', () => {
  it('newest hook waiting refuses', () => {
    const input = {
      ...baseInput(),
      claudeHooks: [doneHook(NOW - 5000), { ...doneHook(NOW - 1000), state: 'waiting' }]
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('newest hook blocked refuses', () => {
    const input = { ...baseInput(), claudeHooks: [{ ...doneHook(NOW - 1000), state: 'blocked' }] }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('an OLDER waiting hook superseded by a newer done hook does not refuse', () => {
    const input = {
      ...baseInput(),
      claudeHooks: [{ ...doneHook(NOW - 5000), state: 'waiting' }, doneHook(NOW - 1000)]
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(true)
  })
  // MUTANT PROOF (guard d): deleting `if (newestHook && (newestHook.state === 'waiting' ||
  // newestHook.state === 'blocked')) return false` makes the first two tests above return true.
})

describe('guard (g) [G1 B3]: at least one Claude hook row must exist for the pane key at all', () => {
  it('no Claude hook rows at all refuses, even though (a)-(d) all hold', () => {
    expect(canAttemptUnobservedStarvationEscape({ ...baseInput(), claudeHooks: [] })).toBe(false)
  })

  it('a hook row for a DIFFERENT pane key does not count', () => {
    const input = {
      ...baseInput(),
      claudeHooks: [{ ...doneHook(NOW - 1000), paneKey: 'other-pane' }]
    }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('a hook row for a different agentType does not count', () => {
    const input = { ...baseInput(), claudeHooks: [{ ...doneHook(NOW - 1000), agentType: 'codex' }] }
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(false)
  })

  it('one restored hook row of ANY age/state (other than waiting/blocked) is enough', () => {
    const input = { ...baseInput(), claudeHooks: [doneHook(NOW - 6 * 24 * 3600_000)] } // 6 days old.
    expect(canAttemptUnobservedStarvationEscape(input)).toBe(true)
  })
  // MUTANT PROOF (guard g): deleting `if (!newestHook) return false` makes the first test above
  // (`claudeHooks: []`) return true instead of false — see the lane return for the verbatim tail.
})

describe('hasEscapedRecently: the per-mailbox/per-pane throttle primitive', () => {
  it('no prior escape at all is not "recent"', () => {
    expect(hasEscapedRecently(undefined, NOW, BOUND_MS)).toBe(false)
  })

  it('an escape inside the bound is "recent"', () => {
    expect(hasEscapedRecently(NOW - BOUND_MS + 1, NOW, BOUND_MS)).toBe(true)
  })

  it('an escape at/after the bound is no longer "recent"', () => {
    expect(hasEscapedRecently(NOW - BOUND_MS, NOW, BOUND_MS)).toBe(false)
  })
})
