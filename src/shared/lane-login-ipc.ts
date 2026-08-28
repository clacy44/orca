// S9-L2 (design rev 38 §2l/§3): the renderer-facing IPC surface over `LaneLoginDesktopService`.
// Every request/result mirrors the RPC shapes in `claude-lane-login-rpc.ts` plus the
// `environmentId` that selects which paired host the call targets (the login flow is per remote
// environment, exactly as the delegate/refresh actions in `principal-lane-status-ipc.ts` are).
import type {
  LaneAccountRow,
  LaneLoginCapabilityState,
  LaneLoginIdentity
} from './claude-lane-login-rpc'

export type LaneLoginRefused = { code: string; message: string }

export type LaneLoginEnvironmentSnapshotDto = {
  environmentId: string
  capability: LaneLoginCapabilityState
  accounts: LaneAccountRow[]
  activeLoginSessionId: string | null
  activeLoginExpiresAt: number | null
  lastLoginError: LaneLoginRefused | null
}

export type LaneLoginStartRequest = { environmentId: string; expectedEmail: string }
export type LaneLoginStartResponse =
  | { loginSessionId: string; authorizeUrl: string; expiresAt: number }
  | { refused: LaneLoginRefused }

export type LaneLoginSubmitCodeRequest = {
  environmentId: string
  loginSessionId: string
  code: string
}
export type LaneLoginSubmitCodeResponse =
  | {
      status: 'completed' | 'rejected'
      identity: LaneLoginIdentity | null
      attemptsRemaining: number
    }
  | { refused: LaneLoginRefused }

export type LaneLoginCancelRequest = { environmentId: string; loginSessionId: string }
export type LaneLoginCancelResponse = { cancelled: boolean }

export type LaneSelectAccountRequest = { environmentId: string; laneAccountId: string }
export type LaneSelectAccountResponse = { active: string } | { refused: LaneLoginRefused }

export type LaneRemoveAccountRequest = { environmentId: string; laneAccountId: string }
export type LaneRemoveAccountResponse = { removed: string } | { refused: LaneLoginRefused }

export type LaneLogoutRequest = { environmentId: string }
export type LaneLogoutResponse = { cleared: string[] } | { refused: LaneLoginRefused }

export const LANE_LOGIN_GET_CHANNEL = 'laneLogin:get'
export const LANE_LOGIN_CHANGED_CHANNEL = 'laneLogin:changed'
export const LANE_LOGIN_START_CHANNEL = 'laneLogin:start'
export const LANE_LOGIN_SUBMIT_CODE_CHANNEL = 'laneLogin:submitCode'
export const LANE_LOGIN_CANCEL_CHANNEL = 'laneLogin:cancel'
export const LANE_LOGIN_SELECT_ACCOUNT_CHANNEL = 'laneLogin:selectAccount'
export const LANE_LOGIN_REMOVE_ACCOUNT_CHANNEL = 'laneLogin:removeAccount'
export const LANE_LOGIN_LOGOUT_CHANNEL = 'laneLogin:logout'
