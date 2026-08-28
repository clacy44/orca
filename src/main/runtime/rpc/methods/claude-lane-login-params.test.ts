import { describe, expect, it } from 'vitest'
import {
  LaneLoginSubmitCodeInlineParams,
  LaneLoginSubmitCodeParams
} from './claude-lane-login-params'

const PRINCIPAL_ID = '11112222-3333-4444-8555-666677778888'

describe('LaneLoginSubmitCodeParams / LaneLoginSubmitCodeInlineParams (S9-L1 §rpcs item 2)', () => {
  it('accepts an ordinary code up to the 512-char cap', () => {
    const result = LaneLoginSubmitCodeParams.safeParse({
      loginSessionId: 'session-1',
      code: 'a'.repeat(512)
    })
    expect(result.success).toBe(true)
  })

  it('refuses a code past the 512-char cap', () => {
    const result = LaneLoginSubmitCodeParams.safeParse({
      loginSessionId: 'session-1',
      code: 'a'.repeat(513)
    })
    expect(result.success).toBe(false)
  })

  // The failure this guards against: one `submitCode` call smuggling several newline-terminated
  // codes past `MAX_LOGIN_CODE_ATTEMPTS`, since `lane-login-session.ts` writes `code` verbatim to
  // the login child's stdin.
  it('refuses a code carrying an embedded newline', () => {
    const result = LaneLoginSubmitCodeParams.safeParse({
      loginSessionId: 'session-1',
      code: 'c1\nc2\nc3\nc4\nc5\nc6\nc7\nc8\nc9\nc10'
    })
    expect(result.success).toBe(false)
  })

  it('refuses a code carrying any other control character (tab, CR, NUL, DEL)', () => {
    for (const ch of ['\t', '\r', '\x00', '\x7f']) {
      const result = LaneLoginSubmitCodeParams.safeParse({
        loginSessionId: 'session-1',
        code: `123${ch}456`
      })
      expect(result.success).toBe(false)
    }
  })

  it('the host-inline variant applies the identical code guard', () => {
    const clean = LaneLoginSubmitCodeInlineParams.safeParse({
      principalId: PRINCIPAL_ID,
      loginSessionId: 'session-1',
      code: '123456'
    })
    expect(clean.success).toBe(true)

    const withNewline = LaneLoginSubmitCodeInlineParams.safeParse({
      principalId: PRINCIPAL_ID,
      loginSessionId: 'session-1',
      code: 'c1\nc2'
    })
    expect(withNewline.success).toBe(false)
  })
})
