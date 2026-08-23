import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  MAX_LANE_DELEGABLE_ACCOUNTS,
  type ClaudeLaneDelegationRow
} from '../../shared/claude-lane-delegation'
import { LaneDelegationDirectory, parseDelegableAccountInputs } from './lane-delegation-directory'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

function makeDirectory() {
  let rows: ClaudeLaneDelegationRow[] = []
  return new LaneDelegationDirectory({
    getClaudeLaneDelegationRows: () => rows,
    setClaudeLaneDelegationRows: (next) => {
      rows = [...next]
    }
  })
}

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('lane delegation directory', () => {
  it('mints an opaque token per entry that is never the client ref', () => {
    const directory = makeDirectory()
    const minted = directory.setDelegableAccounts(LANE_A, [
      { clientRef: 'ref-1', displayName: 'Work' },
      { clientRef: 'ref-2', displayName: 'Personal' }
    ])
    expect(minted).toHaveLength(2)
    for (const account of minted) {
      expect(account.delegatedAccountId).not.toBe(account.clientRef)
      expect(account.delegatedAccountId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('keeps a token stable across a re-write so a phone holding it can still spend it', () => {
    const directory = makeDirectory()
    const first = directory.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    const second = directory.setDelegableAccounts(LANE_A, [
      { clientRef: 'ref-1', displayName: 'Renamed' },
      { clientRef: 'ref-2' }
    ])
    expect(second[0]?.delegatedAccountId).toBe(first[0]?.delegatedAccountId)
    expect(second[0]?.displayName).toBe('Renamed')
  })

  it('drops a token the desktop stopped listing, and refuses it by name afterwards', () => {
    const directory = makeDirectory()
    const [dropped] = directory.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    directory.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-2' }])
    expect(
      refusalCode(() =>
        directory.resolveDelegatedAccount(LANE_A, dropped?.delegatedAccountId ?? '')
      )
    ).toBe('accounts.lane.delegable_account_unknown')
  })

  it('never resolves another principal token', () => {
    const directory = makeDirectory()
    const [mine] = directory.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    directory.setDelegableAccounts(LANE_B, [{ clientRef: 'ref-9' }])
    expect(
      refusalCode(() => directory.resolveDelegatedAccount(LANE_B, mine?.delegatedAccountId ?? ''))
    ).toBe('accounts.lane.delegable_account_unknown')
    expect(directory.resolveDelegatedAccount(LANE_A, mine?.delegatedAccountId ?? '')).toMatchObject(
      { clientRef: 'ref-1' }
    )
  })

  it('keeps the held display name separate from the delegable list', () => {
    const directory = makeDirectory()
    directory.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    directory.setHeldDisplayName(LANE_A, 'Work')
    expect(directory.getRow(LANE_A).heldDisplayName).toBe('Work')
    expect(directory.getRow(LANE_A).delegable).toHaveLength(1)
    directory.markLaneCleared(LANE_A)
    expect(directory.getRow(LANE_A).heldDisplayName).toBeNull()
    expect(directory.getRow(LANE_A).delegable).toHaveLength(1)
  })

  it('marks the lane cleared, and a later push un-marks it', () => {
    const directory = makeDirectory()
    directory.markLaneCleared(LANE_A)
    expect(directory.getRow(LANE_A).delegationCleared).toBe(true)
    directory.setHeldDisplayName(LANE_A, 'Work')
    expect(directory.getRow(LANE_A).delegationCleared).toBe(false)
  })

  it('answers an unknown lane with an empty row rather than throwing', () => {
    expect(makeDirectory().getRow(LANE_A)).toEqual({
      laneId: LANE_A,
      heldDisplayName: null,
      delegable: []
    })
  })
})

describe('delegable list bounds', () => {
  it('accepts a bounded list of display strings', () => {
    expect(
      parseDelegableAccountInputs([{ clientRef: 'ref-1', displayName: 'Work', email: null }])
    ).toEqual([{ clientRef: 'ref-1', displayName: 'Work', email: null }])
  })

  it('refuses a list past the ceiling but accepts one at it', () => {
    const atCeiling = Array.from({ length: MAX_LANE_DELEGABLE_ACCOUNTS }, (_unused, index) => ({
      clientRef: `ref-${index}`
    }))
    expect(parseDelegableAccountInputs(atCeiling)).toHaveLength(MAX_LANE_DELEGABLE_ACCOUNTS)
    expect(
      refusalCode(() => parseDelegableAccountInputs([...atCeiling, { clientRef: 'ref-extra' }]))
    ).toBe('accounts.lane.delegable_list_invalid')
  })

  it('refuses an over-long or control-character display string', () => {
    for (const displayName of ['x'.repeat(65), `Work${String.fromCharCode(0x00)}`]) {
      expect(
        refusalCode(() => parseDelegableAccountInputs([{ clientRef: 'ref-1', displayName }]))
      ).toBe('accounts.lane.delegable_list_invalid')
    }
    expect(
      refusalCode(() =>
        parseDelegableAccountInputs([{ clientRef: 'ref-1', email: 'x'.repeat(255) }])
      )
    ).toBe('accounts.lane.delegable_list_invalid')
  })

  it('refuses an extra member, a missing client ref and a non-array', () => {
    expect(
      refusalCode(() => parseDelegableAccountInputs([{ clientRef: 'ref-1', accountId: 'acct-1' }]))
    ).toBe('accounts.lane.delegable_list_invalid')
    expect(refusalCode(() => parseDelegableAccountInputs([{ displayName: 'Work' }]))).toBe(
      'accounts.lane.delegable_list_invalid'
    )
    expect(refusalCode(() => parseDelegableAccountInputs({ clientRef: 'ref-1' }))).toBe(
      'accounts.lane.delegable_list_invalid'
    )
  })
})
