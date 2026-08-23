import { describe, expect, it } from 'vitest'
import {
  AGENT_IDENTITY_LANES_CAPABILITY,
  IDLE_SWITCH_STATE,
  NO_LANE,
  readLaneProjection,
  reduceSwitchRequest,
  resolveClaudeSwitchCall,
  type SwitchRequestState
} from './lane-delegated-switch-request'

const SELF_ROW = {
  scope: 'self',
  laneState: 'absent',
  occupied: false,
  ownerLabel: 'Ana',
  displayName: 'Work',
  delegable: [
    { delegatedAccountId: 'token-1', clientRef: 'ref-1', displayName: 'Work', email: null },
    { delegatedAccountId: 'token-2', clientRef: 'ref-2', displayName: null, email: null }
  ]
}
const PEER_ROW = { scope: 'peer', laneState: 'loaded', occupied: true, ownerLabel: 'Ben' }
const CAPS = [AGENT_IDENTITY_LANES_CAPABILITY]

describe('reading the lane projection', () => {
  it('reads an old host snapshot as no lane', () => {
    expect(readLaneProjection({ claude: { accounts: [] } })).toEqual(NO_LANE)
    expect(readLaneProjection(null)).toEqual(NO_LANE)
    expect(readLaneProjection({ claudeLanes: 'nope' })).toEqual(NO_LANE)
  })

  it('reads a snapshot carrying only peer rows as no lane of its own', () => {
    expect(readLaneProjection({ claudeLanes: [PEER_ROW] })).toEqual(NO_LANE)
  })

  it('reads the caller own row and its delegable accounts', () => {
    expect(readLaneProjection({ claudeLanes: [PEER_ROW, SELF_ROW] })).toEqual({
      holdsLane: true,
      laneState: 'absent',
      heldDisplayName: 'Work',
      delegable: [
        { delegatedAccountId: 'token-1', displayName: 'Work', email: null },
        { delegatedAccountId: 'token-2', displayName: null, email: null }
      ]
    })
  })

  it('drops a delegable entry with no token rather than rendering a dead row', () => {
    const projection = readLaneProjection({
      claudeLanes: [{ ...SELF_ROW, delegable: [{ displayName: 'Work' }, SELF_ROW.delegable[0]] }]
    })
    expect(projection.delegable).toHaveLength(1)
  })
})

describe('choosing the switch call', () => {
  it('stays on accounts.selectClaude when the caller holds no lane', () => {
    expect(
      resolveClaudeSwitchCall({
        lane: NO_LANE,
        accountId: 'acct-1',
        delegatedAccountId: 'token-1',
        hostCapabilities: CAPS
      })
    ).toEqual({ method: 'accounts.selectClaude', params: { accountId: 'acct-1' } })
  })

  it('routes to requestSwitch, and never to selectClaude, when the caller holds a lane', () => {
    const lane = readLaneProjection({ claudeLanes: [SELF_ROW] })
    expect(
      resolveClaudeSwitchCall({
        lane,
        accountId: 'acct-1',
        delegatedAccountId: 'token-1',
        hostCapabilities: CAPS
      })
    ).toEqual({
      method: 'accounts.lane.requestSwitch',
      params: { delegatedAccountId: 'token-1' }
    })
  })

  it('refuses to call a new method on a host that does not advertise lanes', () => {
    const lane = readLaneProjection({ claudeLanes: [SELF_ROW] })
    expect(
      resolveClaudeSwitchCall({
        lane,
        accountId: 'acct-1',
        delegatedAccountId: 'token-1',
        hostCapabilities: ['terminal.presence.v1']
      })
    ).toEqual({ method: null, reason: 'unsupported-host' })
  })

  it('makes no call at all for an account the owner has not made delegable', () => {
    const lane = readLaneProjection({ claudeLanes: [SELF_ROW] })
    expect(
      resolveClaudeSwitchCall({
        lane,
        accountId: 'acct-1',
        delegatedAccountId: null,
        hostCapabilities: CAPS
      })
    ).toEqual({ method: null, reason: 'not-delegable' })
  })
})

describe('the pending → outcome state machine', () => {
  const pending: SwitchRequestState = {
    status: 'pending',
    requestId: 'req-1',
    delegatedAccountId: 'token-1'
  }

  it('goes pending on request and stays pending on the return value alone', () => {
    const next = reduceSwitchRequest(IDLE_SWITCH_STATE, {
      type: 'requested',
      requestId: 'req-1',
      delegatedAccountId: 'token-1'
    })
    expect(next).toEqual(pending)
    expect(reduceSwitchRequest(next, { type: 'lane-frame', frame: { type: 'ready' } })).toEqual(
      pending
    )
  })

  it('renders the host sentence verbatim for a timed-out switch', () => {
    const next = reduceSwitchRequest(pending, {
      type: 'lane-frame',
      frame: {
        type: 'switch-failed',
        requestId: 'req-1',
        code: 'accounts.lane.switch_timed_out',
        message: 'Your desktop did not answer the request to switch this Claude account.'
      }
    })
    expect(next).toEqual({
      status: 'failed',
      message: 'Your desktop did not answer the request to switch this Claude account.'
    })
  })

  it('renders the host sentence verbatim for an up-front refusal', () => {
    expect(
      reduceSwitchRequest(IDLE_SWITCH_STATE, {
        type: 'refused',
        message: 'Your desktop is not connected, so this account cannot be switched from here.'
      })
    ).toEqual({
      status: 'failed',
      message: 'Your desktop is not connected, so this account cannot be switched from here.'
    })
  })

  it('settles only from the lane status stream, when the lane actually loads', () => {
    expect(
      reduceSwitchRequest(pending, {
        type: 'lane-frame',
        frame: { type: 'status', status: { laneState: 'absent', heldDisplayName: null } }
      })
    ).toEqual(pending)
    expect(
      reduceSwitchRequest(pending, {
        type: 'lane-frame',
        frame: { type: 'status', status: { laneState: 'loaded', heldDisplayName: 'Work' } }
      })
    ).toEqual({ status: 'switched', displayName: 'Work' })
  })

  it('ignores a frame while idle, so a stray publish cannot fabricate an outcome', () => {
    expect(
      reduceSwitchRequest(IDLE_SWITCH_STATE, {
        type: 'lane-frame',
        frame: { type: 'switch-failed', message: 'nope' }
      })
    ).toEqual(IDLE_SWITCH_STATE)
    expect(
      reduceSwitchRequest(IDLE_SWITCH_STATE, {
        type: 'lane-frame',
        frame: { type: 'status', status: { laneState: 'loaded' } }
      })
    ).toEqual(IDLE_SWITCH_STATE)
  })

  it('ignores a malformed frame rather than throwing at the render', () => {
    expect(reduceSwitchRequest(pending, { type: 'lane-frame', frame: 'nope' })).toEqual(pending)
  })
})
