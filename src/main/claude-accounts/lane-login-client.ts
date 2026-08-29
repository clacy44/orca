// S9-L2 (design rev 39 §2l/§3/§6): the desktop main lane-login client — one instance per
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
import type { LaneLoginHostStatus, LaneLoginTransport } from './lane-login-transport'
export type { LaneLoginCapabilityState } from '../../shared/claude-lane-login-rpc'

/** Reconnect backoff after an 'end' frame (release-audit follow-up): 1s, doubling, capped at 30s;
 *  reset to base the moment a subscribe actually succeeds. */
const LANE_LOGIN_RECONNECT_BASE_MS = 1_000
const LANE_LOGIN_RECONNECT_MAX_MS = 30_000

export type LaneLoginHostStatusChange = {
  laneState: 'absent' | 'loaded' | 'reauth-required' | 'restart-required'
  callerIsDelegatedGrant: boolean
  accounts: LaneAccountRow[]
}

export type LaneLoginClientEvents = {
  onCapabilityChanged?: (state: LaneLoginCapabilityState) => void
  onLoginStarted?: (loginSessionId: string, expiresAt: number) => void
  onLoginCompleted?: (loginSessionId: string, identity: LaneLoginIdentity) => void
  onLoginFailed?: (loginSessionId: string, code: string, message: string) => void
  onAccountsChanged?: (accounts: LaneAccountRow[]) => void
  /** Discoverability follow-up: every field of the host's `status` frame this client can use. */
  onStatusChanged?: (status: LaneLoginHostStatusChange) => void
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
  // Single-flight guard (release-audit follow-up): a re-entrant `connect()` fired from inside an
  // in-flight probe (e.g. `notifyHostReachable` racing `getCapabilities`) must join the same
  // probe rather than start a second one.
  private connecting: Promise<LaneLoginCapabilityState> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectBackoffMs = LANE_LOGIN_RECONNECT_BASE_MS
  // Generation guard (adversarial-review follow-up): bumped by `disconnect()` so an in-flight
  // `doConnect()` — or a frame delivered through an already-torn-down subscription's closure —
  // recognizes it is stale and backs off instead of resurrecting state disconnect() just cleared.
  // This is the one mechanism that closes both: (1) a subscribeStatus() that resolves AFTER
  // disconnect() (unsubscribe was null, so disconnect() couldn't tear it down) now tears itself
  // down the moment it notices its generation is stale, instead of being stored; (2) a late 'end'
  // frame delivered through that same stale closure is ignored outright, so it can never schedule
  // a reconnect to a host that was just removed.
  private generation = 0

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

  /** Probes the host and, if supported, opens the status subscription. Idempotent; concurrent
   *  callers share one in-flight probe (mutation proof: dropping this guard doubles both the
   *  `getCapabilities` and `subscribeStatus` call counts under a re-entrant reachable hook).
   *
   *  The guard is armed with a plain field write BEFORE `doConnect()` is invoked — not by
   *  assigning the field from `doConnect()`'s own return value — because a transport whose
   *  `getCapabilities()` calls the reachable hook SYNCHRONOUSLY (as this host's transport can)
   *  re-enters `connect()` while still inside the very call that would produce that return value;
   *  arming the guard as a separate statement first is what the re-entrant call actually observes. */
  async connect(): Promise<LaneLoginCapabilityState> {
    if (this.unsubscribe) {
      return this.capability
    }
    if (this.connecting) {
      return this.connecting
    }
    const gen = ++this.generation
    let resolveConnecting!: (state: LaneLoginCapabilityState) => void
    const connecting = new Promise<LaneLoginCapabilityState>((resolve) => {
      resolveConnecting = resolve
    })
    this.connecting = connecting
    try {
      const state = await this.doConnect(gen)
      resolveConnecting(state)
      return state
    } finally {
      if (this.connecting === connecting) {
        this.connecting = null
      }
    }
  }

  private async doConnect(gen: number): Promise<LaneLoginCapabilityState> {
    // Rule: only transition to 'checking' from 'unknown' — a reconnect after an 'end' frame (or a
    // retry while already 'supported') must never flash 'checking' at a live row.
    if (this.capability === 'unknown') {
      this.setCapability('checking')
    }
    let capabilities: readonly string[]
    try {
      capabilities = await this.transport.getCapabilities()
    } catch {
      if (gen !== this.generation) {
        // disconnect() ran while this probe was in flight — its own state reset stands.
        return this.capability
      }
      this.setCapability('unknown')
      this.scheduleReconnect(gen)
      return this.capability
    }
    if (gen !== this.generation) {
      return this.capability
    }
    if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
      this.setCapability('unsupported')
      return this.capability
    }
    this.setCapability('supported')
    // Never overwrite a live subscription: disconnect any existing one before opening the new one.
    const previousUnsubscribe = this.unsubscribe
    this.unsubscribe = null
    previousUnsubscribe?.()
    const unsubscribe = await this.transport.subscribeStatus((frame) =>
      this.handleFrame(gen, frame)
    )
    if (gen !== this.generation) {
      // BLOCKER 1's exact race: disconnect() ran while subscribeStatus() was in flight, so it saw
      // `unsubscribe === null` and had nothing to tear down. Tear this late subscription down
      // ourselves instead of storing it.
      unsubscribe()
      return this.capability
    }
    this.unsubscribe = unsubscribe
    this.reconnectBackoffMs = LANE_LOGIN_RECONNECT_BASE_MS
    return this.capability
  }

  disconnect(): void {
    this.generation++
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectBackoffMs = LANE_LOGIN_RECONNECT_BASE_MS
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Bounded backoff after a repeated 'end': silent, never touches `capability`. */
  private scheduleReconnect(gen: number): void {
    if (this.reconnectTimer) {
      return
    }
    const delay = this.reconnectBackoffMs
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (gen !== this.generation) {
        // BLOCKER 2 belt-and-suspenders: even if a stale frame slipped past the closure guard,
        // never reconnect to a host disconnect() already moved past.
        return
      }
      void this.connect()
    }, delay)
    timer.unref?.()
    this.reconnectTimer = timer
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, LANE_LOGIN_RECONNECT_MAX_MS)
  }

  private applyStatus(status: LaneLoginHostStatus | undefined): void {
    if (status?.accounts) {
      this.events.onAccountsChanged?.(status.accounts)
    }
    if (status?.laneState) {
      this.events.onStatusChanged?.({
        laneState: status.laneState,
        callerIsDelegatedGrant: status.callerIsDelegatedGrant === true,
        accounts: status.accounts ?? []
      })
    }
  }

  private handleFrame(
    gen: number,
    frame:
      | LaneLoginStatusFrame
      | { type: 'ready'; subscriptionId: string; status: LaneLoginHostStatus }
      | { type: 'status'; status: LaneLoginHostStatus }
      | { type: 'end' }
  ): void {
    if (gen !== this.generation) {
      // BLOCKER 2: a frame (in particular 'end') delivered through an already-disconnected
      // subscription's own closure must never resurrect state disconnect() already moved past —
      // most importantly, it must never schedule a reconnect to a host that was just removed.
      return
    }
    if (frame.type === 'login-started') {
      this.events.onLoginStarted?.(frame.loginSessionId, frame.expiresAt)
    } else if (frame.type === 'login-completed') {
      this.events.onLoginCompleted?.(frame.loginSessionId, frame.identity)
    } else if (frame.type === 'login-failed') {
      this.events.onLoginFailed?.(frame.loginSessionId, frame.code, frame.message)
    } else if (frame.type === 'ready' || frame.type === 'status') {
      // The host pushes 'ready' with the current status synchronously on subscribe
      // (`accounts.lane.statusSubscribe`'s handler) — no separate one-shot status read is needed
      // to populate the snapshot truthfully.
      this.applyStatus(frame.status)
    } else if (frame.type === 'end') {
      this.unsubscribe = null
      this.scheduleReconnect(gen)
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
