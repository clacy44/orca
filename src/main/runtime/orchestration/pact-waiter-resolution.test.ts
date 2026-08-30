import { describe, expect, it } from 'vitest'
import { pactWaiterHandleForAgent, waiterMatchesPactResolution } from './pact-waiter-resolution'

describe('pactWaiterHandleForAgent', () => {
  it('addresses the agent mailbox', () => {
    expect(pactWaiterHandleForAgent('agent_1')).toBe('agent:agent_1')
  })
})

describe('waiterMatchesPactResolution', () => {
  it('never matches a legacy waiter that registered no `for`, regardless of thread', () => {
    expect(waiterMatchesPactResolution({ for: undefined, threadId: 'thr_1' }, 'thr_1')).toBe(false)
    expect(waiterMatchesPactResolution({ for: 'message', threadId: 'thr_1' }, 'thr_1')).toBe(false)
  })

  // A4: "a released pact must wake a `--for reply` park too" — without this the counterpart
  // that asked a question parks against a pact that no longer exists and sleeps to the clamp.
  it('matches a for:reply park on the released thread, and on any thread for turn_arrived', () => {
    expect(waiterMatchesPactResolution({ for: 'reply', threadId: 'thr_1' }, 'thr_1')).toBe(true)
    expect(waiterMatchesPactResolution({ for: 'reply', threadId: 'thr_1' }, null)).toBe(true)
    // Negative control: a reply park on a different thread is still none of this pact's business.
    expect(waiterMatchesPactResolution({ for: 'reply', threadId: 'thr_2' }, 'thr_1')).toBe(false)
  })

  it('matches a pact/step waiter only on its own thread', () => {
    expect(waiterMatchesPactResolution({ for: 'pact', threadId: 'thr_1' }, 'thr_1')).toBe(true)
    expect(waiterMatchesPactResolution({ for: 'step', threadId: 'thr_1' }, 'thr_2')).toBe(false)
  })

  it('a null threadId (turn_arrived) matches on any thread', () => {
    expect(waiterMatchesPactResolution({ for: 'pact', threadId: 'thr_1' }, null)).toBe(true)
    expect(waiterMatchesPactResolution({ for: 'step', threadId: 'thr_9' }, null)).toBe(true)
  })
})
