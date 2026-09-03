// Split out of principal-registry.ts (max-lines ratchet): the one-device-row -> LaneGrantSummary
// projection `listGrants()` maps over. F-11 (Ruling 32(b)) added `accessProfile` here.
import { effectiveAccessProfile } from './device-registry-field-normalizers'
import type { LaneGrantSummary, PrincipalGrantRow } from './principal-grant-source'

export function buildLaneGrantSummary(
  device: PrincipalGrantRow,
  args: {
    boundPrincipalId: string | null
    designated: boolean
    legacyGrantProfile: 'full' | 'peer'
  }
): LaneGrantSummary {
  return {
    deviceId: device.deviceId,
    label: device.name,
    perPerson: device.pendingExpiresAt !== undefined,
    boundPrincipalId: args.boundPrincipalId,
    designated: args.designated,
    // M1: an un-redeemed per-person invite (§9 step 0.2's checkable precondition).
    redeemed: device.lastSeenAt > 0,
    // F-11: the persisted row's fact, never the mint-time request (lane-format.ts:239 is the
    // only other place a profile is echoed, and that is the requested flag, not this).
    accessProfile: effectiveAccessProfile(device, args.legacyGrantProfile)
  }
}
