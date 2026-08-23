import { randomUUID } from 'node:crypto'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  LANE_ACCOUNT_EMAIL_MAX_LENGTH,
  LANE_CLIENT_REF_MAX_LENGTH,
  LANE_DISPLAY_NAME_MAX_LENGTH,
  MAX_LANE_DELEGABLE_ACCOUNTS,
  isPrintableLaneString,
  normalizeLaneDisplayName,
  type ClaudeLaneDelegableAccount,
  type ClaudeLaneDelegationRow
} from '../../shared/claude-lane-delegation'

/**
 * §2l step 1's delegable-account list, and the owner-authored name the lane currently holds.
 *
 * RESOLVES §8 open item 2. Rev 21 gives that list a reader and no writer: §2b closes the push
 * envelope at exactly three members and refuses a fourth, and §2b states the host never receives
 * the owner's account inventory — so the list cannot ride the push. It is therefore its own
 * desktop→host write (`accounts.lane.setDelegableAccounts`), authorized exactly as a push is and
 * bounded exactly as §2b bounds its own strings.
 *
 * The TOKEN is host-minted, never the desktop's account id. It is kept stable across re-writes by
 * the desktop's own opaque `clientRef`, so a phone holding a token from ten minutes ago can still
 * spend it; anything the desktop stops listing loses its token and is refused by name.
 */

export type LaneDelegationPersistence = {
  getClaudeLaneDelegationRows(): ClaudeLaneDelegationRow[]
  setClaudeLaneDelegationRows(rows: readonly ClaudeLaneDelegationRow[]): void
}

/** What the delegated desktop sends: display strings and its OWN opaque handle. */
export type DelegableAccountInput = {
  clientRef: string
  displayName?: string | null
  email?: string | null
}

const EMPTY_ROW = (laneId: string): ClaudeLaneDelegationRow => ({
  laneId,
  heldDisplayName: null,
  delegable: []
})

export class LaneDelegationDirectory {
  constructor(private readonly persistence: LaneDelegationPersistence) {}

  getRow(laneId: string): ClaudeLaneDelegationRow {
    return (
      this.persistence.getClaudeLaneDelegationRows().find((row) => row.laneId === laneId) ??
      EMPTY_ROW(laneId)
    )
  }

  /** A landed push is what un-does a clear: the lane holds a credential again. */
  setHeldDisplayName(laneId: string, displayName: string | null): void {
    const row = this.getRow(laneId)
    this.putRow({
      ...row,
      heldDisplayName: normalizeLaneDisplayName(displayName),
      delegationCleared: false
    })
  }

  /**
   * §2e's clear arm, published so every bound desktop RELEASES its lease.
   *
   * A cleared lane keeps its watermark and its designation on purpose, so a status frame after a
   * clear is otherwise indistinguishable from one after §2f's close-wipe — which must not release.
   */
  markLaneCleared(laneId: string): void {
    this.putRow({ ...this.getRow(laneId), heldDisplayName: null, delegationCleared: true })
  }

  /** Mints or re-uses one opaque token per entry, in the order the desktop listed them. */
  setDelegableAccounts(
    laneId: string,
    entries: readonly DelegableAccountInput[]
  ): ClaudeLaneDelegableAccount[] {
    const existing = new Map(
      this.getRow(laneId).delegable.map((account) => [account.clientRef, account])
    )
    const seenRefs = new Set<string>()
    const delegable: ClaudeLaneDelegableAccount[] = []
    for (const entry of entries) {
      if (seenRefs.has(entry.clientRef)) {
        continue
      }
      seenRefs.add(entry.clientRef)
      delegable.push({
        delegatedAccountId: existing.get(entry.clientRef)?.delegatedAccountId ?? randomUUID(),
        clientRef: entry.clientRef,
        displayName: normalizeLaneDisplayName(entry.displayName),
        email: normalizeDelegableEmail(entry.email)
      })
    }
    this.putRow({ ...this.getRow(laneId), delegable })
    return delegable
  }

  /** §2l step 2: the token is validated against THIS principal's list and no other's. */
  resolveDelegatedAccount(laneId: string, delegatedAccountId: string): ClaudeLaneDelegableAccount {
    const account = this.getRow(laneId).delegable.find(
      (row) => row.delegatedAccountId === delegatedAccountId
    )
    if (!account) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.delegable_account_unknown',
        'That Claude account is no longer offered for switching from this device, so nothing was changed. Open Orca on the desktop that owns the account and tick it again.'
      )
    }
    return account
  }

  forgetLane(laneId: string): void {
    const rows = this.persistence
      .getClaudeLaneDelegationRows()
      .filter((row) => row.laneId !== laneId)
    this.persistence.setClaudeLaneDelegationRows(rows)
  }

  private putRow(row: ClaudeLaneDelegationRow): void {
    const rows = this.persistence
      .getClaudeLaneDelegationRows()
      .filter((existing) => existing.laneId !== row.laneId)
    this.persistence.setClaudeLaneDelegationRows([...rows, row])
  }
}

/**
 * Bounds and shape-validates the desktop's list BEFORE it is stored — the owner-authored strings
 * on it cross the wire exactly as §2b's `displayName` does, and get the same treatment.
 */
export function parseDelegableAccountInputs(value: unknown): DelegableAccountInput[] {
  if (!Array.isArray(value) || value.length > MAX_LANE_DELEGABLE_ACCOUNTS) {
    throw delegableListInvalid()
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw delegableListInvalid()
    }
    const record = entry as Record<string, unknown>
    const extra = Object.keys(record).find(
      (key) => key !== 'clientRef' && key !== 'displayName' && key !== 'email'
    )
    const clientRef = record.clientRef
    if (
      extra !== undefined ||
      typeof clientRef !== 'string' ||
      clientRef.length === 0 ||
      clientRef.length > LANE_CLIENT_REF_MAX_LENGTH ||
      !isPrintableLaneString(clientRef)
    ) {
      throw delegableListInvalid()
    }
    return {
      clientRef,
      displayName: readBoundedString(record.displayName, LANE_DISPLAY_NAME_MAX_LENGTH),
      email: readBoundedString(record.email, LANE_ACCOUNT_EMAIL_MAX_LENGTH)
    }
  })
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || value.length > maxLength || !isPrintableLaneString(value)) {
    throw delegableListInvalid()
  }
  return value
}

function normalizeDelegableEmail(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !isPrintableLaneString(value)) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > LANE_ACCOUNT_EMAIL_MAX_LENGTH ? null : trimmed
}

function delegableListInvalid(): ClaudeLaneRefusal {
  return new ClaudeLaneRefusal(
    'accounts.lane.delegable_list_invalid',
    'Orca refused this list of switchable Claude accounts because it was not the bounded set of names it expects, so the previous list is unchanged. Update Orca on the desktop that owns the accounts.'
  )
}
