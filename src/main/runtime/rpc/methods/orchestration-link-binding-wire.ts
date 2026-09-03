// S10-16 C3, R7.3/R7.4 (design v6, frozen): the wire shapes for the two link-binding peer RPCs —
// split out of orchestration-link-binding-peer.ts to stay under the max-lines ratchet.
import { z } from 'zod'
import {
  LINK_BINDING_PROTOCOL,
  LINK_BINDING_HEX32_RE,
  LINK_BINDING_HEX64_RE
} from '../../orchestration/link-binding-proof'
import { LINK_BINDING_PROBE_SLOTS } from '../../orchestration/link-binding-constants'

export const FederatedLinkProbeParams = z
  .object({
    protocol: z.literal(LINK_BINDING_PROTOCOL),
    probeId: z.string().regex(LINK_BINDING_HEX32_RE),
    nonceH: z.string().regex(LINK_BINDING_HEX64_RE),
    epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    selectors: z.array(z.string().regex(LINK_BINDING_HEX64_RE)).length(LINK_BINDING_PROBE_SLOTS)
  })
  .strict()

export type FederatedLinkSlotResult =
  | {
      slotIndex: number
      matched: true
      nonceP: string
      proof: string
      // R7.7: diagnostics only, never an input — the verifier checks every proof against its own
      // locally computed values.
      observedChannelFp: string
      peerKeyFingerprint: string
    }
  | { slotIndex: number; matched: false; reason: 'peer_duplicate' }

export type FederatedLinkAdvisory = {
  kind: 'link_contested' | 'link_quarantined'
  incidentId: string
}

export type FederatedLinkProbeResult = {
  protocol: string
  results: FederatedLinkSlotResult[]
  advisory?: FederatedLinkAdvisory
}

export const FederatedLinkConfirmParams = z
  .object({
    protocol: z.literal(LINK_BINDING_PROTOCOL),
    probeId: z.string().regex(LINK_BINDING_HEX32_RE),
    confirms: z
      .array(
        z.object({
          slotIndex: z
            .number()
            .int()
            .min(0)
            .max(LINK_BINDING_PROBE_SLOTS - 1),
          confirm: z.string().regex(LINK_BINDING_HEX64_RE)
        })
      )
      .min(1)
      .max(LINK_BINDING_PROBE_SLOTS)
  })
  .strict()

export type FederatedLinkConfirmResult = { protocol: string; acknowledged: number[] }

export type PendingSlot = {
  environmentId: string
  nonceP: string
  observedChannelFp: string
  dstKeyFp: string
}

export type PendingAnswer = {
  createdAt: number
  nonceH: string
  epoch: number
  selectors: readonly string[]
  results: FederatedLinkProbeResult
  bySlot: Map<number, PendingSlot>
}
