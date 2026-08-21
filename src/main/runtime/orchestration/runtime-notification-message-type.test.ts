import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MESSAGE_TYPES, RUNTIME_NOTIFICATION_MESSAGE_TYPE } from './types'

// Read the guide source instead of importing the bundle it generates: `src/cli` is outside this
// tsconfig project, and `verify:bundled-skill-guides` already pins the bundle to this file.
const ORCHESTRATION_GUIDE = readFileSync(
  new URL('../../../../skill-guides/orchestration.md', import.meta.url),
  'utf8'
)

describe('runtime notification message type', () => {
  it('is a shipped message type, so no CHECK-constraint migration is implied', () => {
    expect(MESSAGE_TYPES).toContain(RUNTIME_NOTIFICATION_MESSAGE_TYPE)
  })

  it('is in the filter the bundled guide teaches coordinators to wait on', () => {
    // Why pin the guide text: a type outside this filter reaches the inbox without waking the
    // waiter, which is the whole failure this constant exists to prevent.
    expect(ORCHESTRATION_GUIDE).toContain(
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
