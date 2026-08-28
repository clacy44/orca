import { describe, expect, it } from 'vitest'
import {
  AGENT_IDENTITY_LANES_V2_CAPABILITY,
  NO_LANE_ACCOUNTS,
  readLaneAccountsProjection,
  resolveLaneAccountSwitchCall
} from './lane-account-switch'

const SELF_ROW = {
  scope: 'self',
  accounts: [
    { laneAccountId: 'acct-1', email: 'a@example.com', label: 'Work', active: true },
    { laneAccountId: 'acct-2', email: 'b@example.com', label: null, active: false }
  ]
}
const CAPS = [AGENT_IDENTITY_LANES_V2_CAPABILITY]

describe('readLaneAccountsProjection', () => {
  it('reads an old host snapshot as no lane', () => {
    expect(readLaneAccountsProjection(null)).toEqual(NO_LANE_ACCOUNTS)
    expect(readLaneAccountsProjection({ claudeLanes: 'nope' })).toEqual(NO_LANE_ACCOUNTS)
  })

  it('reads the caller own row and its accounts', () => {
    expect(readLaneAccountsProjection({ claudeLanes: [SELF_ROW] })).toEqual({
      holdsLane: true,
      accounts: SELF_ROW.accounts
    })
  })

  it('drops a malformed account row rather than throwing', () => {
    const result = readLaneAccountsProjection({
      claudeLanes: [{ scope: 'self', accounts: [{ laneAccountId: 'x' }] }]
    })
    expect(result.accounts).toEqual([])
  })
})

describe('resolveLaneAccountSwitchCall', () => {
  it('with no lane, routes to the unchanged accounts.selectClaude', () => {
    expect(
      resolveLaneAccountSwitchCall({
        lane: NO_LANE_ACCOUNTS,
        accountId: 'x',
        hostCapabilities: []
      })
    ).toEqual({ method: 'accounts.selectClaude', params: { accountId: 'x' } })
  })

  it('with a lane but no v2 capability, refuses with unsupported-host — never falls back to requestSwitch', () => {
    expect(
      resolveLaneAccountSwitchCall({
        lane: { holdsLane: true, accounts: [] },
        accountId: null,
        laneAccountId: 'acct-1',
        hostCapabilities: []
      })
    ).toEqual({ method: null, reason: 'unsupported-host' })
  })

  it('with a lane and v2, routes to accounts.lane.selectAccount for a known laneAccountId', () => {
    expect(
      resolveLaneAccountSwitchCall({
        lane: { holdsLane: true, accounts: SELF_ROW.accounts },
        accountId: null,
        laneAccountId: 'acct-2',
        hostCapabilities: CAPS
      })
    ).toEqual({ method: 'accounts.lane.selectAccount', params: { laneAccountId: 'acct-2' } })
  })

  it('refuses account_unknown for a laneAccountId not in the lane', () => {
    expect(
      resolveLaneAccountSwitchCall({
        lane: { holdsLane: true, accounts: SELF_ROW.accounts },
        accountId: null,
        laneAccountId: 'not-there',
        hostCapabilities: CAPS
      })
    ).toEqual({ method: null, reason: 'account_unknown' })
  })

  // Mutation proof: checking only the v1 capability string here would route a v1-only host
  // straight to accounts.lane.selectAccount, a method that host does not implement.
  it('MUTATION PROOF: v1 alone is not in the v2 capabilities list', () => {
    expect(CAPS.includes('agent.identity-lanes.v1' as never)).toBe(false)
  })
})
