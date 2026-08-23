import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'

/**
 * Proof that a lane/principal write came from a human at this machine.
 *
 * Constructible only through `authorizeHostConsent`, so a registry write cannot be reached
 * without passing the caller-class check: no client may cause a binding, a designation or a lane
 * (S9 §2a). The value is deliberately opaque — it carries authority, not data.
 *
 * There is deliberately no second, check-free factory for the host renderer: the renderer arm
 * lands with the IPC caller that can prove its sender, and until then one constructor means one
 * check that no caller can forget.
 */
export type HostConsent = { readonly source: 'local-socket' }

export type ConsentCaller = {
  /** `undefined` is the local socket or an in-process (renderer) call; any value is a paired grant. */
  clientKind?: 'mobile' | 'runtime'
}

export function authorizeHostConsent(caller: ConsentCaller): HostConsent {
  if (caller.clientKind !== undefined) {
    throw new ClaudeLaneRefusal(
      'accounts.lane.consent_caller_not_local',
      'Binding a device to a person, designating who pushes, and provisioning a credential lane are decisions made at the host machine. Do them in Orca on the host, or with the local `orca` command there.'
    )
  }
  return { source: 'local-socket' }
}
