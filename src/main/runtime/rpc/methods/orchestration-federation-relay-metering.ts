// S10-19 W-5 (attacker 7): split out of orchestration-federation-relay.ts to stay under the
// max-lines ratchet. federationImport/Pull/Ack were unmetered and items had no array bound —
// without both, R25/INV-P-006(a) overclaim on the one store §6.6 designates. One shared budget
// (PEER_MAILBOX_PER_MINUTE, via meterPeerLink) applies regardless of the caller's access
// profile, since this relay path is reachable by any runtime-scope pairing, not only a peer one.
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { meterPeerLink } from '../../runtime-peer-rpc-allowlist'

export const FEDERATION_RELAY_ITEMS_MAX = 200
export const FEDERATION_RELAY_PAYLOAD_MAX_LENGTH = 8_000

export function assertFederationRelayMetered(
  runtime: Parameters<typeof meterPeerLink>[0]['runtime'],
  callerFingerprint: string | undefined
): void {
  const metered = meterPeerLink({ runtime, callerFingerprint: callerFingerprint ?? '' }, 'relay')
  if (metered.refused) {
    throw new OrchestrationError('rate_limited', metered.message, {
      retryAfterMs: metered.retryAfterMs
    })
  }
}
