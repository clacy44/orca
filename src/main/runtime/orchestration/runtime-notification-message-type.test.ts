import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../../../cli/bundled-skill-guides'
import { MESSAGE_TYPES, RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'

const ORCHESTRATION_GUIDE = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orchestration')!

describe('runtime notification message type', () => {
  it('is a shipped message type, so no CHECK-constraint migration is implied', () => {
    expect(MESSAGE_TYPES).toContain(RUNTIME_NOTIFICATION_MESSAGE_TYPE)
  })

  it('is in the filter the bundled guide teaches coordinators to wait on', () => {
    // Why pin the guide text: a type outside this filter reaches the inbox without waking the
    // waiter, which is the whole failure this constant exists to prevent.
    expect(ORCHESTRATION_GUIDE.fullMarkdown).toContain(
      `--types worker_done,${RUNTIME_NOTIFICATION_MESSAGE_TYPE},question`
    )
  })

  it('is not `status`, the type the one existing runtime notification uses', () => {
    // Negative control: `status` is a legal message type and would pass every schema check,
    // and that is exactly why the convention has to be written down.
    expect(RUNTIME_NOTIFICATION_MESSAGE_TYPE).not.toBe('status')
    expect(MESSAGE_TYPES).toContain('status')
  })
})
