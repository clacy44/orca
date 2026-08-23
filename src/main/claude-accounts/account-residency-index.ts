import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readIdentityFromOauthAccount, readRefreshTokenSha256 } from './claude-credential-identity'

/**
 * Invariant L1 — one account, at most one lane (S9 §2e).
 *
 * A refresh token is single-use, so residency is per ACCOUNT. Rows are keyed by `accountUuid`
 * AND `sha256(refreshToken)`, and a collision on EITHER refuses: the shared lane legitimately
 * holds an unmanaged system login that carries no `oauthAccount` at all, and an accountUuid-keyed
 * axis cannot see that side.
 */

export type AccountResidencyHolder =
  | { kind: 'host' }
  | { kind: 'lane'; laneId: string; presenceLabel: string | null }

export type AccountResidencyKeys = {
  accountUuid: string | null
  refreshTokenSha256: string | null
}

export type ResidencyCandidateAccount = AccountResidencyKeys & {
  /** Orca's managed account id; carried for the caller's own logging, never for matching. */
  accountId: string
}

/** The shared lane's FILES — `~/.claude` — not the managed account that may not exist. */
export type SharedLaneCredentialReader = {
  readCredentials(): string | null
  readOauthAccount(): unknown
}

export type AccountResidencyIndexOptions = {
  sharedLane: SharedLaneCredentialReader
  /** The holding principal's presence label, which the refusal names as the remedy's address. */
  resolvePresenceLabel?: (laneId: string) => string | null
}

export class AccountResidencyIndex {
  private hostRow: AccountResidencyKeys | null = null
  private readonly laneRows = new Map<string, AccountResidencyKeys>()

  constructor(private readonly options: AccountResidencyIndexOptions) {}

  /**
   * Re-derives the `host` row from the shared lane's files.
   *
   * Called on every shared-lane `doSyncForCurrentSelection` AND immediately before each residency
   * check: an external `claude login` into `~/.claude`, or a `selectClaude` landing between two
   * syncs, otherwise produces a collision nothing observes.
   */
  refreshHostRow(): void {
    const credentialsJson = this.options.sharedLane.readCredentials()
    if (credentialsJson === null) {
      this.hostRow = null
      return
    }
    this.hostRow = {
      accountUuid: readIdentityFromOauthAccount(this.options.sharedLane.readOauthAccount())
        .accountUuid,
      refreshTokenSha256: readRefreshTokenSha256(credentialsJson)
    }
  }

  setLaneRow(laneId: string, credentialsJson: string, oauthAccount: unknown): void {
    this.laneRows.set(laneId, {
      accountUuid: readIdentityFromOauthAccount(oauthAccount).accountUuid,
      refreshTokenSha256: readRefreshTokenSha256(credentialsJson)
    })
  }

  clearLaneRow(laneId: string): void {
    this.laneRows.delete(laneId)
  }

  getLaneRowKeys(laneId: string): AccountResidencyKeys | null {
    const row = this.laneRows.get(laneId)
    return row ? { ...row } : null
  }

  /**
   * The lane holding this account, or null. Never reports the shared lane.
   *
   * Single-valued only because of L1, which §2d's two `accounts.ts` gates have yet to enforce. The
   * shared-lane omission is deliberate — the shared lane is not a lane to be refused into — and it
   * is exactly why `assertAccountNotResidentElsewhere` consults the host row separately.
   */
  findLaneResidency(
    keys: AccountResidencyKeys,
    excludeLaneId?: string
  ): Extract<AccountResidencyHolder, { kind: 'lane' }> | null {
    for (const [laneId, row] of this.laneRows) {
      if (laneId === excludeLaneId || !residencyKeysCollide(keys, row)) {
        continue
      }
      return {
        kind: 'lane',
        laneId,
        presenceLabel: this.options.resolvePresenceLabel?.(laneId) ?? null
      }
    }
    return null
  }

  /**
   * §2d's single predicate, called from `selectClaude`, `removeClaude` and `accounts.lane.push`.
   *
   * The host row is re-derived first, not because the shared lane can hold a LANE, but because
   * the same call is what keeps that row honest for the push check below.
   *
   * NOT YET CALLED FROM PRODUCTION — S9b's push RPC and the two `accounts.ts` gates are 3b's, and
   * BOTH `selectClaude` and `removeClaude` are owed, not only the push. Until then L1 is
   * unenforced, and the lane rotation gate rests on it: `isRefreshDeferredByLivePty` resolves
   * liveness through `findLaneResidency`, which never reports the shared lane, so a live
   * shared-lane `claude` holding the same account would not defer a lane's rotation. Unreachable
   * only because no lane can be loaded without a push RPC.
   */
  assertNotLaneResident(account: ResidencyCandidateAccount): void {
    this.refreshHostRow()
    const holder = this.findLaneResidency(account)
    if (holder) {
      throw residentElsewhereRefusal(holder)
    }
  }

  /**
   * The push edge: another lane OR the shared lane's own files.
   *
   * Without the host arm, a push of the very account whose refresh token is live in an unmanaged
   * `~/.claude` is accepted and the single-use token sits in two config dirs.
   */
  assertAccountNotResidentElsewhere(account: ResidencyCandidateAccount, laneId: string): void {
    this.refreshHostRow()
    const holder = this.findLaneResidency(account, laneId)
    if (holder) {
      throw residentElsewhereRefusal(holder)
    }
    if (this.hostRow && residencyKeysCollide(account, this.hostRow)) {
      throw residentElsewhereRefusal({ kind: 'host' })
    }
  }
}

/** A collision on EITHER key. `null` never matches `null`: an unknown key is not a match. */
export function residencyKeysCollide(
  left: AccountResidencyKeys,
  right: AccountResidencyKeys
): boolean {
  if (left.accountUuid !== null && left.accountUuid === right.accountUuid) {
    return true
  }
  return left.refreshTokenSha256 !== null && left.refreshTokenSha256 === right.refreshTokenSha256
}

function residentElsewhereRefusal(holder: AccountResidencyHolder): ClaudeLaneRefusal {
  const where =
    holder.kind === 'host'
      ? "this host's own shared Claude login"
      : `${holder.presenceLabel ?? 'another person'}'s personal credential lane`
  const remedy =
    holder.kind === 'host'
      ? 'Sign that account out of the shared login on the host first, then try again.'
      : `Ask ${holder.presenceLabel ?? 'them'} to clear their lane first, then try again.`
  return new ClaudeLaneRefusal(
    'accounts.lane.account_resident_elsewhere',
    `That Claude account is already loaded in ${where}, and one account can only live in one place on a host because its refresh token is single-use. ${remedy}`
  )
}
