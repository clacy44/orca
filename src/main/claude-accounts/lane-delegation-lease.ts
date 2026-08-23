import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import {
  CLAUDE_LANE_LEASE_TTL_MS,
  type ClaudeLaneDelegationLease
} from '../../shared/claude-lane-lease'

/**
 * The desktop half of §2e's delegation lease.
 *
 * While an account is delegated to a host lane, on EVERY desktop bound to that principal — the
 * named `delegatedGrantId` included, and that inclusion is the whole point:
 *   (i)   `refreshManagedAccountTokenIfNeeded` is a no-op for it. The holder is the PUSHING
 *         desktop, so exempting it leaves an unsuppressed rotator sitting on the single-use
 *         refresh token the lane's live `claude` holds — R2 broken on the ordinary principal.
 *   (ii)  its own managed launches under that account are refused.
 *   (iii) the host's rotation receipt is the only writer of the account's stored credential.
 *   (iv)  the account is cleared out of this machine's OWN runtime `~/.claude`, and a local
 *         `selectClaude` of it is refused — the third copy (i) and (ii) do not reach, which a
 *         plain `claude` in any non-Orca terminal would otherwise read and rotate.
 *
 * Suppression keys on the EXISTENCE of a published delegation for the account, never on who holds
 * it and never on a push arriving. Release is an `accounts.lane.clear`, a revoke (the host stops
 * publishing a designation) or expiry — never a restart and never a dropped connection.
 */

export type LaneDelegationLeasePersistence = {
  getClaudeLaneDelegationLeases(): ClaudeLaneDelegationLease[]
  setClaudeLaneDelegationLeases(rows: readonly ClaudeLaneDelegationLease[]): void
}

export type LaneDelegationLeaseOptions = {
  persistence: LaneDelegationLeasePersistence
  now?: () => number
  ttlMs?: number
  /** Rule (iv): clears the account out of this machine's own runtime credential file. */
  clearRuntimeCredentials?: (lease: ClaudeLaneDelegationLease) => void
}

export type LaneDelegationLeaseInput = {
  accountId: string
  accountUuid: string | null
  hostId: string
  principalId: string
  delegatedGrantId: string
}

export class LaneDelegationLeaseStore {
  constructor(private readonly options: LaneDelegationLeaseOptions) {}

  list(): ClaudeLaneDelegationLease[] {
    return this.options.persistence.getClaudeLaneDelegationLeases()
  }

  leaseFor(accountId: string): ClaudeLaneDelegationLease | null {
    const row = this.list().find((lease) => lease.accountId === accountId)
    return row && !this.isExpired(row) ? row : null
  }

  isDelegated(accountId: string | null | undefined): boolean {
    return accountId ? this.leaseFor(accountId) !== null : false
  }

  /** Taking a lease is also rule (iv)'s clearing action, not only a record. */
  take(input: LaneDelegationLeaseInput): ClaudeLaneDelegationLease {
    const existing = this.list().find((lease) => lease.accountId === input.accountId)
    const now = this.now()
    const lease: ClaudeLaneDelegationLease = {
      ...input,
      since: existing?.since ?? now,
      expiresAt: now + (this.options.ttlMs ?? CLAUDE_LANE_LEASE_TTL_MS)
    }
    this.put(lease)
    this.options.clearRuntimeCredentials?.(lease)
    return lease
  }

  release(accountId: string): boolean {
    const rows = this.list()
    const next = rows.filter((lease) => lease.accountId !== accountId)
    if (next.length === rows.length) {
      return false
    }
    this.options.persistence.setClaudeLaneDelegationLeases(next)
    return true
  }

  /**
   * Reconciles against one host's published lane status: the host's value wins.
   *
   * A status carrying a designation AND an identity this desktop recognises takes (or renews) the
   * lease. A status carrying NO designation is the revoke/unbind case and releases. A status whose
   * lane simply holds a different account releases only that account's lease — the lane moved on.
   *
   * `delegationCleared` is the third of §2e's exactly three releases. It cannot be inferred: a
   * clear keeps the watermark AND the designation on purpose, so without the flag a post-clear
   * status still resolves an identity and RENEWS the lease the owner just asked to give back.
   */
  applyPublishedStatus(
    hostId: string,
    status: ClaudeLaneStatus,
    resolveLocalAccountId: (identity: ClaudeLaneStatus['heldIdentity']) => string | null
  ): void {
    const held = status.heldIdentity
    const accountId = held ? resolveLocalAccountId(held) : null
    if (status.delegationCleared === true || !status.delegatedGrantId) {
      this.releaseForPrincipal(hostId, status.laneId)
      return
    }
    if (!accountId) {
      return
    }
    this.take({
      accountId,
      accountUuid: held?.accountUuid ?? null,
      hostId,
      principalId: status.laneId,
      delegatedGrantId: status.delegatedGrantId
    })
    for (const lease of this.list()) {
      if (
        lease.hostId === hostId &&
        lease.principalId === status.laneId &&
        lease.accountId !== accountId
      ) {
        this.release(lease.accountId)
      }
    }
  }

  releaseForPrincipal(hostId: string, principalId: string): void {
    for (const lease of this.list()) {
      if (lease.hostId === hostId && lease.principalId === principalId) {
        this.release(lease.accountId)
      }
    }
  }

  /** Rule (ii): this desktop's own managed launch under a delegated account. */
  assertLaunchAllowed(accountId: string | null | undefined): void {
    if (this.isDelegated(accountId)) {
      throw delegatedElsewhere(
        'This Claude account is loaded on a shared host right now, so Orca did not start a terminal under it here. Use the terminals on that host, or release the account there first.'
      )
    }
  }

  /** Rule (iv)'s refusal half: a local selection would materialize a third copy. */
  assertLocalSelectionAllowed(accountId: string | null | undefined): void {
    if (this.isDelegated(accountId)) {
      throw delegatedElsewhere(
        'This Claude account is loaded on a shared host right now, so Orca did not switch this machine to it. Release it on that host first, then select it here.'
      )
    }
  }

  private isExpired(lease: ClaudeLaneDelegationLease): boolean {
    return lease.expiresAt !== null && lease.expiresAt <= this.now()
  }

  private put(lease: ClaudeLaneDelegationLease): void {
    const rows = this.list().filter((existing) => existing.accountId !== lease.accountId)
    this.options.persistence.setClaudeLaneDelegationLeases([...rows, lease])
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

let attachedLeases: LaneDelegationLeaseStore | null = null

export function attachLaneDelegationLeaseStore(store: LaneDelegationLeaseStore | null): void {
  attachedLeases = store
}

export function getLaneDelegationLeaseStore(): LaneDelegationLeaseStore | null {
  return attachedLeases
}

/** The delegating calls the ratcheted account funnels take; inert with no lease store attached. */
export function isClaudeAccountDelegatedToLane(accountId: string | null | undefined): boolean {
  return attachedLeases?.isDelegated(accountId) ?? false
}

export function assertClaudeAccountNotDelegatedToLane(accountId: string | null | undefined): void {
  attachedLeases?.assertLocalSelectionAllowed(accountId)
}

export function assertClaudeLaunchNotDelegatedToLane(accountId: string | null | undefined): void {
  attachedLeases?.assertLaunchAllowed(accountId)
}

function delegatedElsewhere(message: string): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal('accounts.lane.delegated_elsewhere', message)
}
