import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY } from './protocol-version'

/**
 * `mobile/` compiles under its own tsconfig and cannot import `src/shared`, so it re-declares the
 * capability string. Nothing else stops the two drifting into a silently ungated phone.
 *
 * Rev 32 (S9-L3, §10(g)) deletes the push model's v1 routing module
 * (`lane-delegated-switch-request.ts`); `lane-account-switch.ts` is its v2 replacement.
 */
describe('mobile lane capability literal', () => {
  it('equals the host-advertised runtime capability', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'mobile', 'src', 'accounts', 'lane-account-switch.ts'),
      'utf-8'
    )
    const declared = /AGENT_IDENTITY_LANES_V2_CAPABILITY\s*=\s*'([^']+)'/.exec(source)?.[1]

    expect(declared).toBe(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)
  })
})
