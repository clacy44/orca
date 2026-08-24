import { beforeEach, describe, expect, it } from 'vitest'
import {
  AccountResidencyIndex,
  residencyKeysCollide,
  type SharedLaneCredentialReader
} from './account-residency-index'
import { hashRefreshToken } from './claude-credential-identity'

const LANE_A = 'lane-a'
const LANE_B = 'lane-b'

const credentials = (refreshToken: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken } })

class FakeSharedLane implements SharedLaneCredentialReader {
  credentialsJson: string | null = null
  oauthAccount: unknown = null
  reads = 0

  readCredentials(): string | null {
    this.reads += 1
    return this.credentialsJson
  }

  readOauthAccount(): unknown {
    return this.oauthAccount
  }
}

describe('account residency index', () => {
  let sharedLane: FakeSharedLane
  let index: AccountResidencyIndex

  beforeEach(() => {
    sharedLane = new FakeSharedLane()
    index = new AccountResidencyIndex({
      sharedLane,
      resolvePresenceLabel: (laneId) => (laneId === LANE_A ? 'Ada' : null)
    })
  })

  it('refuses a second lane for an account matched by accountUuid', () => {
    index.setLaneRow(LANE_A, credentials('rt-a'), { accountUuid: 'acc-1' })
    expect(() =>
      index.assertNotLaneResident({
        accountId: 'orca-1',
        accountUuid: 'acc-1',
        refreshTokenSha256: hashRefreshToken('something-else')
      })
    ).toThrow(/Ada's personal credential lane/)
  })

  it('refuses a second lane for an account matched only by refresh-token sha', () => {
    // The unmanaged case: no oauthAccount at all, so the sha is the only key there is.
    index.setLaneRow(LANE_A, credentials('rt-a'), null)
    expect(() =>
      index.assertNotLaneResident({
        accountId: 'orca-1',
        accountUuid: null,
        refreshTokenSha256: hashRefreshToken('rt-a')
      })
    ).toThrow(/one account can only live in one place/)
  })

  it('allows an account that collides on neither key', () => {
    index.setLaneRow(LANE_A, credentials('rt-a'), { accountUuid: 'acc-1' })
    expect(() =>
      index.assertNotLaneResident({
        accountId: 'orca-2',
        accountUuid: 'acc-2',
        refreshTokenSha256: hashRefreshToken('rt-b')
      })
    ).not.toThrow()
  })

  it('never matches two unknown keys against each other', () => {
    index.setLaneRow(LANE_A, '{not json', null)
    expect(() =>
      index.assertNotLaneResident({ accountId: 'x', accountUuid: null, refreshTokenSha256: null })
    ).not.toThrow()
    expect(
      residencyKeysCollide(
        { accountUuid: null, refreshTokenSha256: null },
        { accountUuid: null, refreshTokenSha256: null }
      )
    ).toBe(false)
  })

  it('lets a lane re-push its own account without colliding with itself', () => {
    index.setLaneRow(LANE_A, credentials('rt-a'), { accountUuid: 'acc-1' })
    expect(() =>
      index.assertAccountNotResidentElsewhere(
        { accountId: 'orca-1', accountUuid: 'acc-1', refreshTokenSha256: hashRefreshToken('rt-a') },
        LANE_A
      )
    ).not.toThrow()
    expect(() =>
      index.assertAccountNotResidentElsewhere(
        { accountId: 'orca-1', accountUuid: 'acc-1', refreshTokenSha256: hashRefreshToken('rt-a') },
        LANE_B
      )
    ).toThrow(/Ada/)
  })

  it('refuses a push of the account whose token is live in an unmanaged shared login', () => {
    // No oauthAccount on the host side at all — the sha-keyed host row is the only witness.
    sharedLane.credentialsJson = credentials('rt-host')
    expect(() =>
      index.assertAccountNotResidentElsewhere(
        {
          accountId: 'orca-1',
          accountUuid: 'acc-1',
          refreshTokenSha256: hashRefreshToken('rt-host')
        },
        LANE_A
      )
    ).toThrow(/shared Claude login/)
  })

  it('re-derives the host row before every check, not once at startup', () => {
    const account = {
      accountId: 'orca-1',
      accountUuid: null,
      refreshTokenSha256: hashRefreshToken('rt-late')
    }
    index.refreshHostRow()
    expect(() => index.assertAccountNotResidentElsewhere(account, LANE_A)).not.toThrow()
    // A `claude login` into the shared lane landing between two syncs.
    sharedLane.credentialsJson = credentials('rt-late')
    expect(() => index.assertAccountNotResidentElsewhere(account, LANE_A)).toThrow(
      /shared Claude login/
    )
  })

  it('forgets a lane row when the lane is cleared', () => {
    index.setLaneRow(LANE_A, credentials('rt-a'), { accountUuid: 'acc-1' })
    expect(index.getLaneRowKeys(LANE_A)?.accountUuid).toBe('acc-1')
    index.clearLaneRow(LANE_A)
    expect(index.getLaneRowKeys(LANE_A)).toBeNull()
    expect(() =>
      index.assertNotLaneResident({
        accountId: 'orca-1',
        accountUuid: 'acc-1',
        refreshTokenSha256: null
      })
    ).not.toThrow()
  })

  it('names the holding principal, falling back when no label resolves', () => {
    index.setLaneRow(LANE_B, credentials('rt-b'), { accountUuid: 'acc-b' })
    expect(() =>
      index.assertNotLaneResident({
        accountId: 'orca-b',
        accountUuid: 'acc-b',
        refreshTokenSha256: null
      })
    ).toThrow(/another person's personal credential lane/)
  })
})
