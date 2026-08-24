import type {
  PrincipalConsentBindResult,
  PrincipalConsentCreatePrincipalResult,
  PrincipalConsentDeprovisionResult,
  PrincipalConsentDesignateResult,
  PrincipalConsentProvisionResult,
  PrincipalConsentSnapshot,
  PrincipalConsentUnbindResult
} from '../../shared/principal-consent-ipc'

// Why an IPC surface and not a wire one (S9 §2a, §10(d) Part 4): binding a device to a person,
// designating a pusher and provisioning a lane are host-side consent acts, and the main bridge
// sender-gates every channel so ONLY the desktop's own frame reaches them — there is no capability
// negotiated, nothing published to a paired client. The paired-grant half of a row (device name,
// last-seen) already arrives through the access-grant list; this carries the registry half alone.
export type PrincipalConsentApi = {
  /** Principals, bindings and the audit trail. A non-host frame gets the empty snapshot. */
  snapshot: () => Promise<PrincipalConsentSnapshot>
  createPrincipal: (displayName: string) => Promise<PrincipalConsentCreatePrincipalResult>
  bind: (deviceId: string, principalId: string) => Promise<PrincipalConsentBindResult>
  unbind: (deviceId: string) => Promise<PrincipalConsentUnbindResult>
  /** Unbind-then-bind, so the audit trail carries both directions (§2a). */
  rebind: (deviceId: string, principalId: string) => Promise<PrincipalConsentBindResult>
  designatePusher: (
    principalId: string,
    deviceId: string
  ) => Promise<PrincipalConsentDesignateResult>
  provision: (principalId: string) => Promise<PrincipalConsentProvisionResult>
  deprovision: (principalId: string) => Promise<PrincipalConsentDeprovisionResult>
  /** Every write republishes the snapshot; read once on mount and keep it fresh through this. */
  onChanged: (callback: (snapshot: PrincipalConsentSnapshot) => void) => () => void
}
