import { describe, expect, it } from 'vitest'
import { authorizeHostConsent } from './principal-consent-authority'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

// S9 §2a: binding, designation and provisioning are host-side consent acts, and `authorizeHostConsent`
// is the SINGLE constructor of the `HostConsent` every registry write demands — so this boundary is
// where "no consent action is reachable from a remote-client code path" is enforced. The host-only
// IPC seam and the local `orca` socket both call in with no `clientKind`; a paired grant always
// carries one.
describe('authorizeHostConsent', () => {
  it('admits the local caller — the host renderer / local socket carries no clientKind', () => {
    expect(authorizeHostConsent({})).toEqual({ source: 'local-socket' })
    expect(authorizeHostConsent({ clientKind: undefined })).toEqual({ source: 'local-socket' })
  })

  // Mutation proof: this IS the gate. Delete the `clientKind !== undefined` check and both remote
  // classes would be handed a consent token, so both of these stop throwing.
  it.each(['mobile', 'runtime'] as const)('refuses the %s remote-client path', (clientKind) => {
    expect(() => authorizeHostConsent({ clientKind })).toThrow(ClaudeLaneRefusal)
    expect(() => authorizeHostConsent({ clientKind })).toThrow(/decisions made at the host machine/)
  })
})
