// S9-L2 (design rev 38 §2l/§3/§6): the desktop process's single composition point for lane-login
// clients, one per paired environment — mirrors `LaneDelegationDesktopService`'s shape (module-
// global instance, injectable transport, a status-changed broadcast) so the two are easy to read
// side by side, and so S9-L3 can delete the push half without restructuring this one.
import type {
  LaneAccountRow,
  LaneLoginCapabilityState,
  LaneLoginIdentity
} from '../../shared/claude-lane-login-rpc'
import { LaneLoginClient, LaneLoginRefusedError } from './lane-login-client'
import { createLaneLoginTransport } from './lane-login-transport'

export type LaneLoginEnvironmentSnapshot = {
  environmentId: string
  capability: LaneLoginCapabilityState
  accounts: LaneAccountRow[]
  /** The most recent login session this desktop's grant started against this environment, if any. */
  activeLoginSessionId: string | null
  activeLoginExpiresAt: number | null
  lastLoginError: { code: string; message: string } | null
}

function emptySnapshot(environmentId: string): LaneLoginEnvironmentSnapshot {
  return {
    environmentId,
    capability: 'unknown',
    accounts: [],
    activeLoginSessionId: null,
    activeLoginExpiresAt: null,
    lastLoginError: null
  }
}

export class LaneLoginDesktopService {
  private readonly clients = new Map<string, LaneLoginClient>()
  private readonly snapshots = new Map<string, LaneLoginEnvironmentSnapshot>()
  private listener: (() => void) | null = null

  setStatusListener(listener: (() => void) | null): void {
    this.listener = listener
  }

  private notify(): void {
    this.listener?.()
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
