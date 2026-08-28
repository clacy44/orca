// S9-L2 (design rev 38 §2l/§3/§6): the desktop process's single composition point for lane-login
// clients, one per paired environment — mirrors `LaneDelegationDesktopService`'s shape (module-
// global instance, injectable transport, a status-changed broadcast) so the two are easy to read
// side by side, and so S9-L3 can delete the push half without restructuring this one.
import type {
  LaneAccountRow,
  LaneLoginCapabilityState,
  LaneLoginIdentity
} from '../../shared/claude-lane-login-rpc'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { isUserManagedRuntimeEnvironment } from '../../shared/runtime-environments'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environment-connectivity-handlers'
import { LaneLoginClient, LaneLoginRefusedError } from './lane-login-client'
import { createLaneLoginTransport } from './lane-login-transport'

export type LaneLoginEnvironmentSnapshot = {
  environmentId: string
  capability: LaneLoginCapabilityState
  laneState: 'absent' | 'loaded' | 'reauth-required' | 'restart-required' | null
  callerIsDelegatedGrant: boolean
  accounts: LaneAccountRow[]
  /** The most recent login session this desktop's grant started against this environment, if any. */
  activeLoginSessionId: string | null
  activeLoginExpiresAt: number | null
  lastLoginError: { code: string; message: string } | null
}

/** One remote environment's lane-discoverability row (release-audit follow-up, §6's S9-L3). */
export type RemoteLaneHostRow =
  | { environmentId: string; label: string; state: 'checking' }
  | { environmentId: string; label: string; state: 'unreachable' }
  | { environmentId: string; label: string; state: 'unsupported' }
  | { environmentId: string; label: string; state: 'not-designated' }
  | {
      environmentId: string
      label: string
      state: 'ready'
      laneState: RuntimeTerminalLaneState
    }

function emptySnapshot(environmentId: string): LaneLoginEnvironmentSnapshot {
  return {
    environmentId,
    capability: 'unknown',
    laneState: null,
    callerIsDelegatedGrant: false,
    accounts: [],
    activeLoginSessionId: null,
    activeLoginExpiresAt: null,
    lastLoginError: null
  }
}

export class LaneLoginDesktopService {
  private readonly clients = new Map<string, LaneLoginClient>()
  private readonly snapshots = new Map<string, LaneLoginEnvironmentSnapshot>()
  // A Set, not one field: `lane-login-bridge.ts`'s login-quartet broadcast and
  // `principal-lane-status-bridge.ts`'s discoverability broadcast both listen on this one
  // module-singleton service, and a single-field listener would let the second registration
  // silently displace the first.
  private readonly listeners = new Set<() => void>()

  /** Returns the disposer — call it, never pass `null`, to stop listening. */
  addStatusListener(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private snapshotFor(environmentId: string): LaneLoginEnvironmentSnapshot {
    let snapshot = this.snapshots.get(environmentId)
    if (!snapshot) {
      snapshot = emptySnapshot(environmentId)
      this.snapshots.set(environmentId, snapshot)
    }
    return snapshot
  }

  private clientFor(environmentId: string): LaneLoginClient {
    let client = this.clients.get(environmentId)
    if (!client) {
      client = new LaneLoginClient(createLaneLoginTransport(environmentId), {
        onCapabilityChanged: (capability) => {
          this.snapshots.set(environmentId, { ...this.snapshotFor(environmentId), capability })
          this.notify()
        },
        onLoginStarted: (loginSessionId, expiresAt) => {
          this.snapshots.set(environmentId, {
            ...this.snapshotFor(environmentId),
            activeLoginSessionId: loginSessionId,
            activeLoginExpiresAt: expiresAt,
            lastLoginError: null
          })
          this.notify()
        },
        onLoginCompleted: (_loginSessionId, _identity: LaneLoginIdentity) => {
          this.snapshots.set(environmentId, {
            ...this.snapshotFor(environmentId),
            activeLoginSessionId: null,
            activeLoginExpiresAt: null
          })
          this.notify()
        },
        onLoginFailed: (_loginSessionId, code, message) => {
          this.snapshots.set(environmentId, {
            ...this.snapshotFor(environmentId),
            activeLoginSessionId: null,
            activeLoginExpiresAt: null,
            lastLoginError: { code, message }
          })
          this.notify()
        },
        onAccountsChanged: (accounts) => {
          this.snapshots.set(environmentId, { ...this.snapshotFor(environmentId), accounts })
          this.notify()
        },
        onStatusChanged: (status) => {
          this.snapshots.set(environmentId, {
            ...this.snapshotFor(environmentId),
            laneState: status.laneState,
            callerIsDelegatedGrant: status.callerIsDelegatedGrant,
            accounts: status.accounts
          })
          this.notify()
        }
      })
      this.clients.set(environmentId, client)
    }
    return client
  }

  async connect(environmentId: string): Promise<LaneLoginCapabilityState> {
    const state = await this.clientFor(environmentId).connect()
    this.snapshots.set(environmentId, { ...this.snapshotFor(environmentId), capability: state })
    return state
  }

  getSnapshot(environmentId: string): LaneLoginEnvironmentSnapshot {
    return this.snapshotFor(environmentId)
  }

  async loginStart(
    environmentId: string,
    expectedEmail: string
  ): Promise<
    | { loginSessionId: string; authorizeUrl: string; expiresAt: number }
    | { refused: { code: string; message: string } }
  > {
    try {
      const result = await this.clientFor(environmentId).loginStart(expectedEmail)
      this.snapshots.set(environmentId, {
        ...this.snapshotFor(environmentId),
        activeLoginSessionId: result.loginSessionId,
        activeLoginExpiresAt: result.expiresAt,
        lastLoginError: null
      })
      this.notify()
      return result
    } catch (error) {
      return { refused: refusalOf(error) }
    }
  }

  async loginSubmitCode(
    environmentId: string,
    loginSessionId: string,
    code: string
  ): Promise<
    | {
        status: 'completed' | 'rejected'
        identity: LaneLoginIdentity | null
        attemptsRemaining: number
      }
    | { refused: { code: string; message: string } }
  > {
    try {
      return await this.clientFor(environmentId).loginSubmitCode(loginSessionId, code)
    } catch (error) {
      return { refused: refusalOf(error) }
    }
  }

  async loginCancel(
    environmentId: string,
    loginSessionId: string
  ): Promise<{ cancelled: boolean }> {
    try {
      await this.clientFor(environmentId).loginCancel(loginSessionId)
      this.snapshots.set(environmentId, {
        ...this.snapshotFor(environmentId),
        activeLoginSessionId: null,
        activeLoginExpiresAt: null
      })
      this.notify()
      return { cancelled: true }
    } catch {
      return { cancelled: false }
    }
  }

  async selectAccount(
    environmentId: string,
    laneAccountId: string
  ): Promise<{ active: string } | { refused: { code: string; message: string } }> {
    try {
      return await this.clientFor(environmentId).selectAccount(laneAccountId)
    } catch (error) {
      return { refused: refusalOf(error) }
    }
  }

  async removeAccount(
    environmentId: string,
    laneAccountId: string
  ): Promise<{ removed: string } | { refused: { code: string; message: string } }> {
    try {
      return await this.clientFor(environmentId).removeAccount(laneAccountId)
    } catch (error) {
      return { refused: refusalOf(error) }
    }
  }

  async logout(
    environmentId: string
  ): Promise<{ cleared: string[] } | { refused: { code: string; message: string } }> {
    try {
      const result = await this.clientFor(environmentId).logout()
      this.snapshots.set(environmentId, {
        ...this.snapshotFor(environmentId),
        accounts: [],
        activeLoginSessionId: null,
        activeLoginExpiresAt: null
      })
      this.notify()
      return result
    } catch (error) {
      return { refused: refusalOf(error) }
    }
  }

  disconnect(environmentId: string): void {
    this.clients.get(environmentId)?.disconnect()
  }

  /** Reconnect arm: fired from every reconnect the environment-status seam passes through. */
  notifyHostReachable(environmentId: string): void {
    void this.connect(environmentId)
  }

  /** Disconnect/re-pair/remove arm. */
  notifyHostUnreachable(environmentId: string): void {
    this.disconnect(environmentId)
  }

  /**
   * Explicit refresh IPC arm: the AccountsPane row's own Refresh button.
   *
   * There is no one-shot re-read on this client, only the subscription's own frames, so a refresh
   * disconnects and reconnects — the same round trip `connect()` already makes idempotent-guarded
   * against, just forced past that guard.
   */
  async refreshHost(environmentId: string): Promise<boolean> {
    this.disconnect(environmentId)
    const state = await this.connect(environmentId)
    return state === 'supported'
  }

  /**
   * One discoverability row per REMOTE environment (release-audit follow-up), whether or not this
   * desktop's grant on it is connected, designated, or supported at all.
   */
  listRemoteHostRows(userDataPath: string): RemoteLaneHostRow[] {
    return listEnvironments(userDataPath)
      .filter(isUserManagedRuntimeEnvironment)
      .map((environment) => {
        const label = environment.name
        if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
          return { environmentId: environment.id, label, state: 'unreachable' as const }
        }
        const snapshot = this.snapshots.get(environment.id)
        if (!snapshot || snapshot.capability === 'unknown' || snapshot.capability === 'checking') {
          return { environmentId: environment.id, label, state: 'checking' as const }
        }
        if (snapshot.capability === 'unsupported') {
          return { environmentId: environment.id, label, state: 'unsupported' as const }
        }
        if (!snapshot.callerIsDelegatedGrant || snapshot.laneState === null) {
          return { environmentId: environment.id, label, state: 'not-designated' as const }
        }
        // `restart-required` is a locally-modelled S9d Part 2 value not yet on the wire's
        // `RuntimeTerminalLaneState`; a lane in that state needs a fresh sign-in exactly as a
        // reauth-required one does, so it renders the same badge here.
        const laneState =
          snapshot.laneState === 'restart-required' ? 'reauth-required' : snapshot.laneState
        return {
          environmentId: environment.id,
          label,
          state: 'ready' as const,
          laneState
        }
      })
  }
}

function refusalOf(error: unknown): { code: string; message: string } {
  if (error instanceof LaneLoginRefusedError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

let activeService: LaneLoginDesktopService | null = null

export function startLaneLoginDesktopService(): LaneLoginDesktopService {
  activeService = new LaneLoginDesktopService()
  return activeService
}

export function getLaneLoginDesktopService(): LaneLoginDesktopService | null {
  return activeService
}

/** Test-only: the module-global service must not leak between suites. */
export function resetLaneLoginDesktopServiceForTest(): void {
  activeService = null
}

// Module-level convenience wrappers, mirroring `lane-delegation-desktop-service.ts`'s deleted
// shape so the connectivity-handler and IPC-bridge call sites swap over with a one-line import
// change (§6's S9-L3).

export function addLaneLoginDesktopStatusListener(listener: () => void): () => void {
  return activeService?.addStatusListener(listener) ?? (() => {})
}

export function notifyLaneLoginHostReachable(environmentId: string): void {
  activeService?.notifyHostReachable(environmentId)
}

export function notifyLaneLoginHostUnreachable(environmentId: string): void {
  activeService?.notifyHostUnreachable(environmentId)
}

export function refreshLaneLoginHostStatus(environmentId: string): Promise<boolean> {
  return activeService?.refreshHost(environmentId) ?? Promise.resolve(false)
}

export function listRemoteLaneHostRows(userDataPath: string): RemoteLaneHostRow[] {
  return activeService?.listRemoteHostRows(userDataPath) ?? []
}
