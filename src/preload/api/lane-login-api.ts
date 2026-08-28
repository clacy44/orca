import type {
  LaneLoginCancelResponse,
  LaneLoginEnvironmentSnapshotDto,
  LaneLoginStartResponse,
  LaneLoginSubmitCodeResponse,
  LaneLogoutResponse,
  LaneRemoveAccountResponse,
  LaneSelectAccountResponse
} from '../../shared/lane-login-ipc'

// S9-L2 (design rev 38 §2l/§3): renderer's window into the desktop lane-login client. One
// environment (paired host) at a time per call, matching the per-host shape of
// `principalLaneStatus.delegateAccountToHost`.
export type LaneLoginApi = {
  /** Reads (and, as a side effect, connects/probes) the given environment's lane-login snapshot. */
  get: (environmentId: string) => Promise<LaneLoginEnvironmentSnapshotDto | null>
  /** Republished on capability change, login-session events, and account-list changes. */
  onChanged: (callback: (snapshot: LaneLoginEnvironmentSnapshotDto) => void) => () => void
  start: (environmentId: string, expectedEmail: string) => Promise<LaneLoginStartResponse>
  submitCode: (
    environmentId: string,
    loginSessionId: string,
    code: string
  ) => Promise<LaneLoginSubmitCodeResponse>
  cancel: (environmentId: string, loginSessionId: string) => Promise<LaneLoginCancelResponse>
  selectAccount: (
    environmentId: string,
    laneAccountId: string
  ) => Promise<LaneSelectAccountResponse>
  removeAccount: (
    environmentId: string,
    laneAccountId: string
  ) => Promise<LaneRemoveAccountResponse>
  logout: (environmentId: string) => Promise<LaneLogoutResponse>
}
