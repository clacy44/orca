// S9-L2 (design rev 38 §2l/§3/§6): the desktop main lane-login client — one instance per
// environment, holding the seven RPCs (loginStart/loginSubmitCode/loginCancel/loginStatus,
// selectAccount/removeAccount, logout) plus a live subscription that folds in the three new
// `LaneStatusFrame` login-session members. It replaces the push client's role for account
// sign-in; `LaneDelegationPushClient` is left in place for S9-L3 to delete.
//
// Transport is injected (`LaneLoginTransport`) so this class is exercised against a mock in tests
// while L1's server RPCs are not yet merged into this tree — every call shape here is the EXACT
// shape L1's plan defines, so wiring a real transport later is a constructor argument, not a
// rewrite.
import { AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type {
  LaneAccountRow,
  LaneLoginCapabilityState,
  LaneLoginIdentity,
  LaneLoginStartResult,
  LaneLoginState,
  LaneLoginStatusFrame,
  LaneLoginSubmitCodeResult
} from '../../shared/claude-lane-login-rpc'
import { isLaneLoginRpcError } from '../../shared/claude-lane-login-rpc'
import type { LaneLoginTransport } from './lane-login-transport'
export type { LaneLoginCapabilityState } from '../../shared/claude-lane-login-rpc'

export type LaneLoginClientEvents = {
  onCapabilityChanged?: (state: LaneLoginCapabilityState) => void
  onLoginStarted?: (loginSessionId: string, expiresAt: number) => void
  onLoginCompleted?: (loginSessionId: string, identity: LaneLoginIdentity) => void
  onLoginFailed?: (loginSessionId: string, code: string, message: string) => void
  onAccountsChanged?: (accounts: LaneAccountRow[]) => void
}

/** Thrown for every refused RPC: carries the host's own code + complete sentence (§3 Rule-3 row). */
export class LaneLoginRefusedError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LaneLoginRefusedError'
  }
}

export class LaneLoginClient {
  private capability: LaneLoginCapabilityState = 'unknown'
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly transport: LaneLoginTransport,
    private readonly events: LaneLoginClientEvents = {}
  ) {}

  getCapabilityState(): LaneLoginCapabilityState {
    return this.capability
  }

  private setCapability(next: LaneLoginCapabilityState): void {
    if (this.capability === next) {
      return
    }
    this.capability = next
    this.events.onCapabilityChanged?.(next)
  }

  /** Probes the host and, if supported, opens the status subscription. Idempotent. */
  async connect(): Promise<LaneLoginCapabilityState> {
    if (this.unsubscribe) {
      return this.capability
    }
    this.setCapability('checking')
    let capabilities: readonly string[]
    try {
      capabilities = await this.transport.getCapabilities()
    } catch {
      this.setCapability('unknown')
      return this.capability
    }
    if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
      this.setCapability('unsupported')
      return this.capability
    }
    this.setCapability('supported')
    this.unsubscribe = await this.transport.subscribeStatus((frame) => this.handleFrame(frame))
    return this.capability
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private handleFrame(
    frame: LaneLoginStatusFrame | { type: 'status'; status: unknown } | { type: 'end' }
  ): void {
    if (frame.type === 'login-started') {
      this.events.onLoginStarted?.(frame.loginSessionId, frame.expiresAt)
    } else if (frame.type === 'login-completed') {
      this.events.onLoginCompleted?.(frame.loginSessionId, frame.identity)
    } else if (frame.type === 'login-failed') {
      this.events.onLoginFailed?.(frame.loginSessionId, frame.code, frame.message)
    } else if (frame.type === 'status') {
      const status = frame.status as { accounts?: LaneAccountRow[] } | undefined
      if (status?.accounts) {
        this.events.onAccountsChanged?.(status.accounts)
      }
    } else if (frame.type === 'end') {
      this.unsubscribe = null
    }
  }

  private async invoke<T>(method: string, params?: unknown): Promise<T> {
    try {
      return await this.transport.call<T>(method, params)
    } catch (error) {
      if (isLaneLoginRpcError(error)) {
        throw new LaneLoginRefusedError(error.code, error.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'unknown'
      throw new LaneLoginRefusedError(code, message)
    }
  }

  loginStart(expectedEmail: string): Promise<LaneLoginStartResult> {
    return this.invoke<LaneLoginStartResult>('accounts.lane.loginStart', { expectedEmail })
  }

  loginSubmitCode(loginSessionId: string, code: string): Promise<LaneLoginSubmitCodeResult> {
    return this.invoke<LaneLoginSubmitCodeResult>('accounts.lane.loginSubmitCode', {
      loginSessionId,
      code
    })
  }

  loginCancel(loginSessionId: string): Promise<{ cancelled: true }> {
    return this.invoke<{ cancelled: true }>('accounts.lane.loginCancel', { loginSessionId })
  }

  loginStatus(loginSessionId: string): Promise<{
    state: LaneLoginState
    expiresAt: number
    attempts: number
    identity: LaneLoginIdentity | null
  }> {
    return this.invoke('accounts.lane.loginStatus', { loginSessionId })
  }

  selectAccount(laneAccountId: string): Promise<{ active: string }> {
    return this.invoke<{ active: string }>('accounts.lane.selectAccount', { laneAccountId })
  }

  removeAccount(laneAccountId: string): Promise<{ removed: string }> {
    return this.invoke<{ removed: string }>('accounts.lane.removeAccount', { laneAccountId })
  }

  logout(): Promise<{ cleared: string[] }> {
    return this.invoke<{ cleared: string[] }>('accounts.lane.logout', null)
  }
}
