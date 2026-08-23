import { describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import { LaneDelegationDirectory } from './lane-delegation-directory'
import { LaneDelegatedSwitchService } from './lane-delegated-switch'
import { LaneStatusStream, type LaneStatusFrame } from './lane-status-stream'
import type { LaneWireAuthority, LaneWireCaller } from './lane-wire-authority'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

function makeHarness(options: { designatedGrantId?: string | null } = {}) {
  let rows: ClaudeLaneDelegationRow[] = []
  const delegation = new LaneDelegationDirectory({
    getClaudeLaneDelegationRows: () => rows,
    setClaudeLaneDelegationRows: (next) => {
      rows = [...next]
    }
  })
  const bindings = new Map<string, string>([
    ['desktop-a', LANE_A],
    ['phone-a', LANE_A],
    ['desktop-b', LANE_B]
  ])
  const designations = new Map<string, string | null>([
    [LANE_A, options.designatedGrantId === undefined ? 'desktop-a' : options.designatedGrantId],
    [LANE_B, 'desktop-b']
  ])
  const stream = new LaneStatusStream({ principalOf: (deviceId) => bindings.get(deviceId) ?? null })
  const authority = {
    requireCaller: (pairedDeviceId?: string | null): LaneWireCaller => {
      const principalId = pairedDeviceId ? bindings.get(pairedDeviceId) : undefined
      if (!pairedDeviceId || !principalId) {
        throw new Error('unidentified')
      }
      return { deviceId: pairedDeviceId, principalId }
    }
  } as unknown as LaneWireAuthority
  const timers: { run: () => void }[] = []
  const service = new LaneDelegatedSwitchService({
    authority,
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => designations.get(principalId) ?? null
    },
    delegation,
    stream,
    scheduleTimeout: (run) => {
      const entry = { run }
      timers.push(entry)
      return {
        cancel: () => {
          const index = timers.indexOf(entry)
          if (index !== -1) {
            timers.splice(index, 1)
          }
        }
      }
    }
  })
  const frames = new Map<string, LaneStatusFrame[]>()
  const attach = (deviceId: string): void => {
    const caller = authority.requireCaller(deviceId)
    const received: LaneStatusFrame[] = []
    frames.set(deviceId, received)
    stream.subscribe(caller, `conn-${deviceId}`, (frame) => received.push(frame))
  }
  return { service, delegation, stream, designations, frames, attach, timers }
}

function mintToken(harness: ReturnType<typeof makeHarness>): string {
  return harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])[0]
    .delegatedAccountId
}

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('delegated switch requests', () => {
  it('forwards to every grant of the principal and returns pending, writing no credential', () => {
    const harness = makeHarness()
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [
      { clientRef: 'ref-1', displayName: 'Work' }
    ])
    harness.attach('desktop-a')
    harness.attach('phone-a')
    harness.attach('desktop-b')
    const result = harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    expect(result.status).toBe('pending')
    expect(harness.frames.get('desktop-a')).toEqual([
      {
        type: 'switch-requested',
        requestId: result.requestId,
        delegatedAccountId: account?.delegatedAccountId,
        clientRef: 'ref-1'
      }
    ])
    expect(harness.frames.get('phone-a')).toHaveLength(1)
    expect(harness.frames.get('desktop-b')).toEqual([])
  })

  it('refuses desktop_unavailable BEFORE any frame when the designated grant is not subscribed', () => {
    const harness = makeHarness()
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    harness.attach('phone-a')
    expect(
      refusalCode(() => harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? ''))
    ).toBe('accounts.lane.desktop_unavailable')
    expect(harness.frames.get('phone-a')).toEqual([])
    expect(harness.timers).toHaveLength(0)
  })

  it('emits the frame for a designated PHONE, which is subscribed, and times out instead', () => {
    const harness = makeHarness({ designatedGrantId: 'phone-a' })
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    harness.attach('phone-a')
    const result = harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    expect(harness.frames.get('phone-a')?.[0]).toMatchObject({ type: 'switch-requested' })
    harness.timers[0]?.run()
    expect(harness.frames.get('phone-a')?.[1]).toMatchObject({
      type: 'switch-failed',
      requestId: result.requestId,
      code: 'accounts.lane.switch_timed_out'
    })
  })

  it('refuses a principal with no designation at all, before any frame', () => {
    const harness = makeHarness({ designatedGrantId: null })
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    harness.attach('phone-a')
    expect(
      refusalCode(() => harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? ''))
    ).toBe('accounts.lane.no_pusher_designated')
    expect(harness.frames.get('phone-a')).toEqual([])
  })

  it('refuses an unknown token and another principal token, before any frame', () => {
    const harness = makeHarness()
    harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    const [theirs] = harness.delegation.setDelegableAccounts(LANE_B, [{ clientRef: 'ref-9' }])
    harness.attach('desktop-a')
    harness.attach('phone-a')
    expect(refusalCode(() => harness.service.requestSwitch('phone-a', 'not-a-token'))).toBe(
      'accounts.lane.delegable_account_unknown'
    )
    expect(
      refusalCode(() => harness.service.requestSwitch('phone-a', theirs?.delegatedAccountId ?? ''))
    ).toBe('accounts.lane.delegable_account_unknown')
    expect(harness.frames.get('desktop-a')).toEqual([])
  })

  it('a settled request never expires afterwards', () => {
    const harness = makeHarness()
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    harness.attach('desktop-a')
    harness.attach('phone-a')
    harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    expect(harness.service.hasPendingFor(LANE_A)).toBe(true)
    harness.service.settleForLane(LANE_A)
    expect(harness.service.hasPendingFor(LANE_A)).toBe(false)
    expect(harness.timers).toHaveLength(0)
    expect(harness.frames.get('phone-a')?.map((frame) => frame.type)).toEqual(['switch-requested'])
  })

  it('settles only the lane that was pushed', () => {
    const harness = makeHarness()
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    harness.attach('desktop-a')
    harness.attach('phone-a')
    harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    harness.service.settleForLane(LANE_B)
    expect(harness.service.hasPendingFor(LANE_A)).toBe(true)
  })
})

describe('lane delegated switch bounds', () => {
  it('keeps one outstanding request per lane however many times the phone taps', () => {
    const harness = makeHarness()
    harness.attach('desktop-a')
    harness.attach('phone-a')
    const [account] = harness.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    const first = harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    const second = harness.service.requestSwitch('phone-a', account?.delegatedAccountId ?? '')
    expect(second.requestId).not.toBe(first.requestId)
    expect(harness.timers).toHaveLength(1)
    harness.service.settleForLane(LANE_A)
    expect(harness.service.hasPendingFor(LANE_A)).toBe(false)
    expect(harness.timers).toHaveLength(0)
  })
})

describe('lane status stream scoping', () => {
  it('answers the liveness precondition per grant, not per principal', () => {
    const harness = makeHarness()
    harness.attach('phone-a')
    expect(harness.stream.hasSubscriptionForGrant(LANE_A, 'desktop-a')).toBe(false)
    expect(harness.stream.hasSubscriptionForGrant(LANE_A, 'phone-a')).toBe(true)
    harness.attach('desktop-a')
    expect(harness.stream.hasSubscriptionForGrant(LANE_A, 'desktop-a')).toBe(true)
  })

  it('publishes a receipt to the lane principal and to nobody else', () => {
    const harness = makeHarness()
    harness.attach('desktop-a')
    harness.attach('desktop-b')
    const receipt = {
      laneId: LANE_A,
      identity: { accountUuid: 'acct-1', email: null, organizationUuid: null },
      refreshTokenSha256: 'a'.repeat(64),
      expiresAt: 1,
      cause: 'host' as const
    }
    expect(harness.stream.publishReceipt(receipt)).toBe(1)
    expect(harness.frames.get('desktop-a')).toEqual([{ type: 'receipt', receipt }])
    expect(harness.frames.get('desktop-b')).toEqual([])
  })

  it('unsubscribing one stream leaves the other subscriber attached', () => {
    const harness = makeHarness()
    const stream = harness.stream
    const first = stream.subscribe({ deviceId: 'desktop-a', principalId: LANE_A }, 'c1', vi.fn())
    stream.subscribe({ deviceId: 'phone-a', principalId: LANE_A }, 'c2', vi.fn())
    stream.unsubscribe(first.subscriptionId)
    expect(stream.subscribersOf(LANE_A)).toHaveLength(1)
  })
})

describe('a lane change that is not a push', () => {
  it('refuses the outstanding request by name instead of dropping it silently', () => {
    const harness = makeHarness()
    harness.attach('desktop-a')
    harness.attach('phone-a')
    const { requestId } = harness.service.requestSwitch('phone-a', mintToken(harness))

    harness.service.failForLane(
      LANE_A,
      'accounts.lane.switch_lane_cleared',
      'The Claude account was released on the host while this switch was still waiting.'
    )

    expect(harness.frames.get('phone-a')?.at(-1)).toMatchObject({
      type: 'switch-failed',
      requestId,
      code: 'accounts.lane.switch_lane_cleared'
    })
    expect(harness.service.hasPendingFor(LANE_A)).toBe(false)
    expect(harness.timers).toHaveLength(0)
  })

  // Negative control: a PUSH still settles silently — the phone reads a `switch-failed` for a
  // superseded id as the failure of its current request.
  it('leaves a push settling silently', () => {
    const harness = makeHarness()
    harness.attach('desktop-a')
    harness.attach('phone-a')
    harness.service.requestSwitch('phone-a', mintToken(harness))

    harness.service.settleForLane(LANE_A)

    expect(harness.frames.get('phone-a')?.some((frame) => frame.type === 'switch-failed')).toBe(
      false
    )
    expect(harness.service.hasPendingFor(LANE_A)).toBe(false)
  })
})
