// [R197] Pure unit tests for the launch-prompt fence predicates — Case D of
// D-R197-launch-edge.md. No runtime harness needed; see launch-prompt-fence.ts for the
// INV-P-LAUNCH-EDGE rationale.
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_PROMPT_FENCE_MAX_MS,
  isLaunchPromptFenceExpired,
  isLaunchedClaudePromptTitle
} from './launch-prompt-fence'

describe('R197 Case D: launch-prompt fence predicates', () => {
  it('expiry fires once the fence has been held maxMs', () => {
    const since = 1_000_000
    expect(
      isLaunchPromptFenceExpired(
        since,
        since + LAUNCH_PROMPT_FENCE_MAX_MS,
        LAUNCH_PROMPT_FENCE_MAX_MS
      )
    ).toBe(true)
    expect(
      isLaunchPromptFenceExpired(
        since,
        since + LAUNCH_PROMPT_FENCE_MAX_MS - 1,
        LAUNCH_PROMPT_FENCE_MAX_MS
      )
    ).toBe(false)
  })

  it('a bare shell-authored `claude` title is not the agent — the whole point of the fence', () => {
    expect(isLaunchedClaudePromptTitle('claude')).toBe(false)
  })

  it('Claude-authored evidence clears the fence', () => {
    expect(isLaunchedClaudePromptTitle('✳ anything')).toBe(true)
    expect(isLaunchedClaudePromptTitle('✳')).toBe(true)
  })
})
