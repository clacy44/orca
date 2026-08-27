// Release-audit B3: the desktop side of the lane wire, composed once per desktop process.
//
// `LaneDelegationPushClient` (the desktop's own end of §2c/§2e/§2l step 3) and
// `attachLaneDelegationLeaseStore` (the lease store that arms rules (i)-(iv) on the delegating
// desktop) both existed with zero production construction before this stage — this file is that
// construction, plus the three triggers that keep a client's push current: reconnect, selection
// change, and an explicit delegate action from the AccountsPane.
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { RuntimeTerminalLaneState } from '../../shared/runtime-types'
import type { Store } from '../persistence'
import { readIdentityFromCredentials } from './claude-credential-identity'
import { deleteActiveClaudeKeychainCredentials } from './keychain'
import { createLaneDelegationHostClient } from './lane-delegation-host-client'
import { attachLaneDelegationLeaseStore, LaneDelegationLeaseStore } from './lane-delegation-lease'
import {
  LaneDelegationPushClient,
  type DelegableAccountOffer,
  type DesktopLaneAccountSource,
  type LanePushableAccount
} from './lane-delegation-push-client'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import { clearRuntimeCredentialsForDelegatedAccount } from './runtime-credential-lane-clearing'
import { ClaudeRuntimePathResolver } from './runtime-paths'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

export type DelegableHostRow = {
  environmentId: string
  label: string
  laneId: string
  laneState: RuntimeTerminalLaneState
}

/**
 * One remote Orca environment's lane-discoverability row (discoverability follow-up): unlike
 * `DelegableHostRow`, this exists for EVERY paired environment, not only a designated, connected
 * one — so the AccountsPane can always say why a host offers nothing to delegate onto, rather than
 * rendering nothing at all.
 */
export type RemoteHostLaneRow =
  | { environmentId: string; label: string; state: 'checking' }
  | { environmentId: string; label: string; state: 'unsupported' }
  | { environmentId: string; label: string; state: 'not-designated' }
  | {
      environmentId: string
      label: string
      state: 'ready'
      laneId: string
      laneState: RuntimeTerminalLaneState
    }

class StoreLaneAccountSource implements DesktopLaneAccountSource {
  constructor(private readonly store: Store) {}

  async readSelected(): Promise<LanePushableAccount | null> {
    const accountId = getSelectedClaudeAccountIdForTarget(this.store.getSettings(), {
      runtime: 'host'
    })
    return accountId ? this.readByClientRef(accountId) : null
  }

  async readByClientRef(clientRef: string): Promise<LanePushableAccount | null> {
    const account = this.findAccount(clientRef)
    return account ? toPushable(account) : null
  }

  async listDelegable(): Promise<DelegableAccountOffer[]> {
    return this.store.getSettings().claudeManagedAccounts.map((account) => ({
      clientRef: account.id,
      displayName: account.email,
      email: account.email
    }))
  }

  async applyRotatedCredentials(accountId: string, credentialsJson: string): Promise<void> {
    const account = this.findAccount(accountId)
    const managedAuthPath = account
      ? resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath)
      : null
    if (managedAuthPath) {
      writeClaudeManagedAuthFile(managedAuthPath, '.credentials.json', credentialsJson)
    }
  }

  /** Email first (the identity the push actually carries), then organizationUuid — 0 or ≥2 is null. */
  resolveLocalAccountId(identity: ClaudeCredentialIdentity | null): string | null {
    if (!identity) {
      return null
    }
    const accounts = this.store.getSettings().claudeManagedAccounts
    const byEmail = identity.email
      ? uniqueMatch(accounts, (account) => account.email === identity.email)
      : null
    if (byEmail) {
      return byEmail
    }
    return identity.organizationUuid
      ? uniqueMatch(accounts, (account) => account.organizationUuid === identity.organizationUuid)
      : null
  }

  private findAccount(accountId: string): ClaudeManagedAccount | null {
    return this.store.getSettings().claudeManagedAccounts.find((a) => a.id === accountId) ?? null
  }
}

function uniqueMatch(
  accounts: readonly ClaudeManagedAccount[],
  predicate: (account: ClaudeManagedAccount) => boolean
): string | null {
  const matches = accounts.filter(predicate)
  return matches.length === 1 ? matches[0].id : null
}

function toPushable(account: ClaudeManagedAccount): LanePushableAccount | null {
  const managedAuthPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath)
  if (!managedAuthPath) {
    return null
  }
  const credentialsJson = readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
  if (!credentialsJson) {
    return null
  }
  const oauthAccountJson = readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json') ?? ''
  return {
    accountId: account.id,
    accountUuid: readIdentityFromCredentials(credentialsJson)?.accountUuid ?? null,
    credentialsJson,
    oauthAccountJson,
    displayName: account.email
  }
}

export class LaneDelegationDesktopService {
  private readonly leases: LaneDelegationLeaseStore
  private readonly accounts: DesktopLaneAccountSource
  private readonly clients = new Map<string, LaneDelegationPushClient>()

  constructor(store: Store) {
    const pathResolver = new ClaudeRuntimePathResolver()
    this.leases = new LaneDelegationLeaseStore({
      persistence: store,
      clearRuntimeCredentials: (lease) =>
        clearRuntimeCredentialsForDelegatedAccount(
          pathResolver.getRuntimePaths(),
          { accountUuid: lease.accountUuid, email: null, organizationUuid: null },
          { deleteKeychainItem: (dir) => deleteActiveClaudeKeychainCredentials(dir) }
        ),
      onClearFailed: (lease, error) =>
        console.warn(
          '[lane-delegation-desktop] failed to clear local runtime credentials for a delegated lease:',
          lease.accountId,
          error
        )
    })
    attachLaneDelegationLeaseStore(this.leases)
    this.accounts = new StoreLaneAccountSource(store)
    store.onSettingsChanged((updates) => {
      if (
        'activeClaudeManagedAccountId' in updates ||
        'activeClaudeManagedAccountIdsByRuntime' in updates
      ) {
        for (const client of this.clients.values()) {
          // Skip a host the user explicitly disconnected: it stays in the map (§2e's lease never
          // releases on a drop), but an unrelated selection change must not silently reconnect it
          // and push a credential to a host that was deliberately closed.
          if (client.isConnected()) {
            void client.pushSelection()
          }
        }
      }
    })
  }

  private clientFor(environmentId: string): LaneDelegationPushClient {
    let client = this.clients.get(environmentId)
    if (!client) {
      client = new LaneDelegationPushClient({
        host: createLaneDelegationHostClient(environmentId),
        accounts: this.accounts,
        leases: this.leases,
        onRefused: (method, error) =>
          console.warn(`[lane-delegation-desktop] ${environmentId} refused ${method}:`, error),
        onStatusChanged: () => statusListener?.()
      })
      this.clients.set(environmentId, client)
    }
    return client
  }

  /**
   * Reconnect arm: fired from every reconnect the environment-status seam passes through, and
   * from an `orca environment add`/Add-environment-dialog success (release-audit follow-up — a
   * newly added environment previously sat unconnected until some unrelated reconnect).
   *
   * A subscription that is already live is NOT re-subscribed (`connect()` is idempotent-guarded),
   * so a status the host published while nothing on this client's side changed — a designation on
   * the host that happened between two of this desktop's `status.get` polls — would otherwise
   * never be re-read. `refreshStatus()` spends the real query that closes that gap.
   */
  notifyHostReachable(environmentId: string): void {
    const client = this.clientFor(environmentId)
    if (client.isConnected()) {
      void client.refreshStatus()
    } else {
      void client.connect()
    }
  }

  /** Explicit refresh IPC arm: the AccountsPane row's own Refresh button. */
  async refreshHost(environmentId: string): Promise<void> {
    const client = this.clientFor(environmentId)
    await (client.isConnected() ? client.refreshStatus() : client.connect())
  }

  /** Disconnect/re-pair/remove arm — never releases the lease (§2e: a drop never un-suppresses). */
  notifyHostUnreachable(environmentId: string): void {
    this.clients.get(environmentId)?.disconnect()
  }

  /** Explicit delegate action from the AccountsPane: push one named account onto one host. */
  async delegateAccountToHost(environmentId: string, accountId: string): Promise<boolean> {
    const account = await this.accounts.readByClientRef(accountId)
    if (!account) {
      return false
    }
    const outcome = await this.clientFor(environmentId).pushAccount(account)
    return outcome === 'pushed'
  }

  /** Every connected client whose grant is this lane's designated pusher — B3's delegate targets. */
  listDelegableHosts(userDataPath: string): DelegableHostRow[] {
    return this.listRemoteHostRows(userDataPath).flatMap((row) =>
      row.state === 'ready'
        ? [
            {
              environmentId: row.environmentId,
              label: row.label,
              laneId: row.laneId,
              laneState: row.laneState
            }
          ]
        : []
    )
  }

  /**
   * One discoverability row per REMOTE environment (release-audit follow-up), whether or not this
   * desktop's grant on it is connected, designated, or supported at all — the section this backs
   * must always be able to say why, not just fall silent when there is nothing to delegate onto.
   */
  listRemoteHostRows(userDataPath: string): RemoteHostLaneRow[] {
    return listEnvironments(userDataPath).map((environment) => {
      const label = environment.name
      const client = this.clients.get(environment.id)
      if (!client) {
        return { environmentId: environment.id, label, state: 'checking' }
      }
      if (client.getCapabilityState() === 'unsupported') {
        return { environmentId: environment.id, label, state: 'unsupported' }
      }
      const status = client.getLastStatus()
      if (!status) {
        return { environmentId: environment.id, label, state: 'checking' }
      }
      if (status.callerIsDelegatedGrant !== true) {
        return { environmentId: environment.id, label, state: 'not-designated' }
      }
      return {
        environmentId: environment.id,
        label,
        state: 'ready',
        laneId: status.laneId,
        laneState: status.laneState
      }
    })
  }
}

let activeService: LaneDelegationDesktopService | null = null
// Module-level, not per-instance: the bridge that registers this listener composes independently
// of `startLaneDelegationDesktopService`, and must not lose its registration across a restart.
let statusListener: (() => void) | null = null

/** Discoverability follow-up: lets the IPC bridge re-broadcast whenever any client's status moves. */
export function setLaneDelegationDesktopStatusListener(listener: (() => void) | null): void {
  statusListener = listener
}

export function startLaneDelegationDesktopService(options: {
  store: Store
}): LaneDelegationDesktopService {
  activeService = new LaneDelegationDesktopService(options.store)
  return activeService
}

export function notifyLaneDelegationHostReachable(environmentId: string): void {
  activeService?.notifyHostReachable(environmentId)
}

export function notifyLaneDelegationHostUnreachable(environmentId: string): void {
  activeService?.notifyHostUnreachable(environmentId)
}

export function delegateAccountToLaneHost(
  environmentId: string,
  accountId: string
): Promise<boolean> {
  return activeService?.delegateAccountToHost(environmentId, accountId) ?? Promise.resolve(false)
}

export function listDelegableLaneHosts(userDataPath: string): DelegableHostRow[] {
  return activeService?.listDelegableHosts(userDataPath) ?? []
}

/** The discoverability row list — every remote environment, connected or not (release audit). */
export function listRemoteLaneHostRows(userDataPath: string): RemoteHostLaneRow[] {
  return activeService?.listRemoteHostRows(userDataPath) ?? []
}

/** Explicit refresh IPC arm. */
export function refreshLaneDelegationHostStatus(environmentId: string): Promise<void> {
  return activeService?.refreshHost(environmentId) ?? Promise.resolve()
}

/** Test-only: the module-global service must not leak between suites. */
export function resetLaneDelegationDesktopServiceForTest(): void {
  activeService = null
}
