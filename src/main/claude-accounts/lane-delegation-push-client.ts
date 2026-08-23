import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { LaneDelegationLeaseStore } from './lane-delegation-lease'

/**
 * The desktop's own side of the lane wire (S9 §2c/§2e/§2l step 3).
 *
 * It pushes the SELECTED account's two files into its principal's lane on every selection change
 * and on every reconnect, carrying `basedOn` from the last thing the host told it the lane holds;
 * it answers a `switch-requested` frame with an ordinary push of the account behind that opaque
 * handle — no new credential path is created for the phone; and it pulls every rotation back into
 * its own managed store (Q2), so the desktop's copy never goes stale and the post-wipe re-push
 * cannot restore a revoked blob.
 *
 * The capability is checked BEFORE the first lane call: a new desktop against an old host must
 * never push, and must keep its host-wide switching instead (§3's degradation matrix).
 */

export type LanePushableAccount = {
  accountId: string
  accountUuid: string | null
  credentialsJson: string
  oauthAccountJson: string
  /** The owner-authored per-account name; bounded and control-character-free before it ships. */
  displayName: string | null
}

export type DelegableAccountOffer = {
  clientRef: string
  displayName?: string | null
  email?: string | null
}

export type DesktopLaneAccountSource = {
  readSelected(): Promise<LanePushableAccount | null>
  readByClientRef(clientRef: string): Promise<LanePushableAccount | null>
  listDelegable(): Promise<DelegableAccountOffer[]>
  /** Q2: the rotated blob, written back into this account's own managed store. */
  applyRotatedCredentials(accountId: string, credentialsJson: string): Promise<void>
  resolveLocalAccountId(identity: ClaudeCredentialIdentity | null): string | null
}

export type LaneStatusFrameIn =
  | { type: 'ready'; status: ClaudeLaneStatus }
  | { type: 'status'; status: ClaudeLaneStatus }
  | { type: 'receipt'; receipt: { laneId: string; refreshTokenSha256: string | null } }
  | { type: 'switch-requested'; requestId: string; clientRef: string }
  | { type: 'switch-failed'; requestId: string; code: string; message: string }
  | { type: 'end' }

export type LaneDelegationHostClient = {
  hostId: string
  getCapabilities(): Promise<readonly string[]>
  call<T>(method: string, params?: unknown): Promise<T>
  subscribeLaneStatus(onFrame: (frame: LaneStatusFrameIn) => void): Promise<() => void>
}

export type LaneDelegationPushClientOptions = {
  host: LaneDelegationHostClient
  accounts: DesktopLaneAccountSource
  leases: LaneDelegationLeaseStore
  onRefused?: (method: string, error: unknown) => void
}

export type LanePushOutcome =
  | 'pushed'
  | 'unsupported-host'
  | 'no-selection'
  | 'refused'
  | 'not-delegated'

export class LaneDelegationPushClient {
  private supported: boolean | null = null
  private lastKnownSha: string | null = null
  private principalId: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly options: LaneDelegationPushClientOptions) {}

  /** Reconnect arm: subscribe first, then push, so the ready status supplies `basedOn`. */
  async connect(): Promise<LanePushOutcome> {
    if (!(await this.hostSupportsLanes())) {
      return 'unsupported-host'
    }
    this.unsubscribe ??= await this.options.host.subscribeLaneStatus((frame) => {
      // A throwing frame handler would otherwise surface as an unhandled rejection: rule (iv)'s
      // clear can lose a win32 race with a live `claude`, and that must be reported, not lost.
      void this.onFrame(frame).catch((error) => {
        this.options.onRefused?.('accounts.lane.statusSubscribe', error)
      })
    })
    await this.publishDelegableAccounts()
    return this.pushSelection()
  }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    // Deliberately NOT a lease release: §2e says a dropped connection never un-suppresses.
    this.supported = null
  }

  /** Selection-change arm, and the body of every other push this client performs. */
  async pushSelection(): Promise<LanePushOutcome> {
    const account = await this.options.accounts.readSelected()
    return account ? this.pushAccount(account) : 'no-selection'
  }

  async pushAccount(account: LanePushableAccount): Promise<LanePushOutcome> {
    if (!(await this.hostSupportsLanes())) {
      return 'unsupported-host'
    }
    // `connect` subscribes and pushes without awaiting the ready frame, so on a reconnect the
    // delegation member would otherwise be two empty strings and the push refused push_malformed.
    const delegation = await this.resolveDelegation()
    if (!delegation) {
      return 'not-delegated'
    }
    try {
      const result = await this.options.host.call<{ refreshTokenSha256: string | null }>(
        'accounts.lane.push',
        {
          envelope: {
            credentialsJson: account.credentialsJson,
            oauthAccountJson: account.oauthAccountJson,
            ...(account.displayName ? { displayName: account.displayName } : {})
          },
          basedOnRefreshTokenSha256: this.lastKnownSha,
          delegation: { hostId: this.options.host.hostId, ...delegation, since: Date.now() }
        }
      )
      this.lastKnownSha = result.refreshTokenSha256
      return 'pushed'
    } catch (error) {
      this.options.onRefused?.('accounts.lane.push', error)
      return 'refused'
    }
  }

  private delegatedGrantId: string | null = null

  /**
   * The ready frame, or a one-shot `accounts.lane.status` when it has not landed yet.
   *
   * There is nothing to fake here: the host derives the lane from the socket, so a push carrying
   * placeholder ids is simply a malformed push. A principal with no designated pusher answers
   * `null` and the push is skipped rather than sent to be refused.
   */
  private async resolveDelegation(): Promise<{
    principalId: string
    delegatedGrantId: string
  } | null> {
    if (this.principalId === null || this.delegatedGrantId === null) {
      try {
        this.applyStatus(await this.options.host.call<ClaudeLaneStatus>('accounts.lane.status'))
      } catch (error) {
        this.options.onRefused?.('accounts.lane.status', error)
        return null
      }
    }
    return this.principalId !== null && this.delegatedGrantId !== null
      ? { principalId: this.principalId, delegatedGrantId: this.delegatedGrantId }
      : null
  }

  private async onFrame(frame: LaneStatusFrameIn): Promise<void> {
    if (frame.type === 'ready' || frame.type === 'status') {
      this.applyStatus(frame.status)
      return
    }
    if (frame.type === 'receipt') {
      // The sha the DESKTOP's store holds, captured before the receipt moves the watermark:
      // passing the receipt's own sha would match every time and never pull the rotation back.
      const heldByThisDesktop = this.lastKnownSha
      this.lastKnownSha = frame.receipt.refreshTokenSha256
      await this.pullRotated(heldByThisDesktop)
      return
    }
    if (frame.type === 'switch-requested') {
      const account = await this.options.accounts.readByClientRef(frame.clientRef)
      if (account) {
        await this.pushAccount(account)
      }
    }
  }

  /** The host's published value wins: the local lease row is a cache of it, never an authority. */
  private applyStatus(status: ClaudeLaneStatus): void {
    this.principalId = readString(status?.laneId)
    this.delegatedGrantId = readString(status?.delegatedGrantId)
    if (this.principalId === null) {
      return
    }
    this.lastKnownSha = status.refreshTokenSha256 ?? null
    this.options.leases.applyPublishedStatus(this.options.host.hostId, status, (identity) =>
      this.options.accounts.resolveLocalAccountId(identity)
    )
  }

  /** Q2, on every receipt: a rotation the host performed lands back in the desktop's store. */
  private async pullRotated(knownRefreshTokenSha256: string | null): Promise<void> {
    try {
      const pulled = await this.options.host.call<
        | { rotated: false }
        | { rotated: true; credentialsJson: string; oauthAccountJson: string | null }
      >('accounts.lane.pullRotated', { knownRefreshTokenSha256 })
      if (!pulled.rotated) {
        return
      }
      const accountId = this.options.accounts.resolveLocalAccountId(
        parseIdentity(pulled.oauthAccountJson)
      )
      if (accountId) {
        await this.options.accounts.applyRotatedCredentials(accountId, pulled.credentialsJson)
      }
    } catch (error) {
      this.options.onRefused?.('accounts.lane.pullRotated', error)
    }
  }

  private async publishDelegableAccounts(): Promise<void> {
    try {
      await this.options.host.call('accounts.lane.setDelegableAccounts', {
        accounts: await this.options.accounts.listDelegable()
      })
    } catch (error) {
      this.options.onRefused?.('accounts.lane.setDelegableAccounts', error)
    }
  }

  private async hostSupportsLanes(): Promise<boolean> {
    if (this.supported !== null) {
      return this.supported
    }
    try {
      const capabilities = await this.options.host.getCapabilities()
      this.supported = capabilities.includes(AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY)
    } catch {
      this.supported = false
    }
    return this.supported
  }
}

function parseIdentity(oauthAccountJson: string | null): ClaudeCredentialIdentity | null {
  if (!oauthAccountJson) {
    return null
  }
  try {
    const parsed = JSON.parse(oauthAccountJson) as Record<string, unknown>
    return {
      accountUuid: readString(parsed.accountUuid) ?? readString(parsed.accountId),
      email: readString(parsed.emailAddress) ?? readString(parsed.email),
      organizationUuid: readString(parsed.organizationUuid) ?? readString(parsed.organizationId)
    }
  } catch {
    return null
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
