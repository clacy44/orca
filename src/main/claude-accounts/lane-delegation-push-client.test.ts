import { describe, expect, it, vi } from 'vitest'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import { LaneDelegationLeaseStore } from './lane-delegation-lease'
import {
  LaneDelegationPushClient,
  type LanePushableAccount,
  type LaneStatusFrameIn
} from './lane-delegation-push-client'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const ACCOUNT: LanePushableAccount = {
  accountId: 'acct-1',
  accountUuid: 'acct-uuid-1',
  credentialsJson: JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt-1' } }),
  oauthAccountJson: JSON.stringify({ accountUuid: 'acct-uuid-1', emailAddress: 'ana@corp.test' }),
  displayName: 'Work'
}

const STATUS = (overrides: Partial<ClaudeLaneStatus> = {}): ClaudeLaneStatus => ({
  laneId: LANE_A,
  laneState: 'loaded',
  delegatedGrantId: 'desktop-a',
  callerIsDelegatedGrant: true,
  heldDisplayName: 'Work',
  heldIdentity: { accountUuid: 'acct-uuid-1', email: 'ana@corp.test', organizationUuid: null },
  refreshTokenSha256: 'a'.repeat(64),
  expiresAt: null,
  delegable: [],
  ...overrides
})

function makeClient(
  options: {
    capabilities?: string[]
    pushResult?: unknown
    failPush?: boolean
    failReadByClientRef?: boolean
    /** What a one-shot `accounts.lane.status` answers before the ready frame lands. */
    statusCall?: ClaudeLaneStatus | null
  } = {}
) {
  const calls: { method: string; params: unknown }[] = []
  const refusals: { method: string; error: unknown }[] = []
  let emitFrame: ((frame: LaneStatusFrameIn) => void) | null = null
  const rotatedWrites: { accountId: string; credentialsJson: string }[] = []
  let leaseRows: ClaudeLaneDelegationLease[] = []
  const leases = new LaneDelegationLeaseStore({
    persistence: {
      getClaudeLaneDelegationLeases: () => leaseRows,
      setClaudeLaneDelegationLeases: (rows) => {
        leaseRows = [...rows]
      }
    }
  })
  const pulls: unknown[] = [{ rotated: false }]
  const client = new LaneDelegationPushClient({
    host: {
      hostId: 'host-1',
      getCapabilities: async () =>
        options.capabilities ?? [AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY],
      call: async (method, params) => {
        calls.push({ method, params })
        if (method === 'accounts.lane.push') {
          if (options.failPush) {
            throw new Error('accounts.lane.push_not_delegated')
          }
          return (options.pushResult ?? { refreshTokenSha256: 'b'.repeat(64) }) as never
        }
        if (method === 'accounts.lane.pullRotated') {
          return (pulls.shift() ?? { rotated: false }) as never
        }
        if (method === 'accounts.lane.status') {
          if (options.statusCall === null) {
            throw new Error('accounts.lane.not_provisioned')
          }
          return (options.statusCall ??
            STATUS({ refreshTokenSha256: null, heldIdentity: null })) as never
        }
        return {} as never
      },
      subscribeLaneStatus: async (onFrame) => {
        emitFrame = onFrame
        return () => {
          emitFrame = null
        }
      }
    },
    accounts: {
      readSelected: async () => ACCOUNT,
      readByClientRef: async (clientRef) => {
        if (options.failReadByClientRef) {
          throw new Error('store_locked')
        }
        return clientRef === 'ref-1' ? { ...ACCOUNT, accountId: 'acct-2' } : null
      },
      listDelegable: async () => [{ clientRef: 'ref-1', displayName: 'Work' }],
      applyRotatedCredentials: async (accountId, credentialsJson) => {
        rotatedWrites.push({ accountId, credentialsJson })
      },
      resolveLocalAccountId: (identity) =>
        identity?.accountUuid === 'acct-uuid-1' ? 'acct-1' : null
    },
    leases,
    onRefused: (method, error) => refusals.push({ method, error })
  })
  return {
    client,
    calls,
    refusals,
    leases,
    rotatedWrites,
    queuePull: (value: unknown) => pulls.unshift(value),
    emit: (frame: LaneStatusFrameIn) => emitFrame?.(frame),
    isSubscribed: () => emitFrame !== null
  }
}

describe('desktop lane push client', () => {
  it('never pushes to a host that does not advertise the capability', async () => {
    const harness = makeClient({ capabilities: ['terminal.presence.v1'] })
    expect(await harness.client.connect()).toBe('unsupported-host')
    expect(harness.calls).toEqual([])
    expect(harness.isSubscribed()).toBe(false)
  })

  it('subscribes, publishes its delegable list and pushes the selection on connect', async () => {
    const harness = makeClient()
    expect(await harness.client.connect()).toBe('pushed')
    expect(harness.calls.map((call) => call.method)).toEqual([
      'accounts.lane.setDelegableAccounts',
      'accounts.lane.status',
      'accounts.lane.push'
    ])
    expect(harness.isSubscribed()).toBe(true)
  })

  it('sends exactly the three envelope members and the delegation, and no lane parameter', async () => {
    const harness = makeClient()
    await harness.client.connect()
    const push = harness.calls.find((call) => call.method === 'accounts.lane.push')
      ?.params as Record<string, unknown>
    expect(Object.keys(push).sort()).toEqual([
      'basedOnRefreshTokenSha256',
      'delegation',
      'envelope'
    ])
    expect(Object.keys(push.envelope as object).sort()).toEqual([
      'credentialsJson',
      'displayName',
      'oauthAccountJson'
    ])
    // The delegation member carries real ids, never the empty strings a pre-ready push once sent.
    expect(push.delegation).toMatchObject({
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
  })

  // Regression: `connect` subscribes and pushes without awaiting `ready`, so a push that raced the
  // frame sent `principalId: ''` / `delegatedGrantId: ''` and was refused push_malformed.
  it('asks the host for its lane rather than pushing an empty delegation member', async () => {
    const harness = makeClient()
    expect(await harness.client.connect()).toBe('pushed')
    expect(harness.calls.map((call) => call.method)).toContain('accounts.lane.status')
    const push = harness.calls.find((call) => call.method === 'accounts.lane.push')
      ?.params as Record<string, unknown>
    expect(push.delegation).toMatchObject({ principalId: LANE_A, delegatedGrantId: 'desktop-a' })
  })

  it('skips the push entirely when the principal has no designated pusher', async () => {
    const harness = makeClient({ statusCall: STATUS({ delegatedGrantId: null }) })
    expect(await harness.client.connect()).toBe('not-delegated')
    expect(harness.calls.map((call) => call.method)).not.toContain('accounts.lane.push')
  })

  it('reports a refused status read rather than pushing a placeholder', async () => {
    const harness = makeClient({ statusCall: null })
    expect(await harness.client.connect()).toBe('not-delegated')
    expect(harness.refusals.map((entry) => entry.method)).toEqual(['accounts.lane.status'])
  })

  it('carries basedOn from the last thing the host said the lane holds', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.emit({ type: 'ready', status: STATUS() })
    await harness.client.pushSelection()
    const pushes = harness.calls
      .filter((call) => call.method === 'accounts.lane.push')
      .map(
        (call) => (call.params as { basedOnRefreshTokenSha256: unknown }).basedOnRefreshTokenSha256
      )
    expect(pushes).toEqual([null, 'a'.repeat(64)])
  })

  it('answers a switch-requested frame with an ordinary push of that account', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.calls.length = 0
    harness.emit({ type: 'switch-requested', requestId: 'req-1', clientRef: 'ref-1' })
    await vi.waitFor(() => {
      expect(harness.calls.map((call) => call.method)).toEqual(['accounts.lane.push'])
    })
  })

  it('ignores a switch-requested frame naming a handle it does not own', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.calls.length = 0
    harness.emit({ type: 'switch-requested', requestId: 'req-1', clientRef: 'ref-unknown' })
    await Promise.resolve()
    expect(harness.calls).toEqual([])
  })

  it('pulls a rotation back into its own store on every receipt (Q2)', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.queuePull({
      rotated: true,
      credentialsJson: '{"claudeAiOauth":{"accessToken":"at-2"}}',
      oauthAccountJson: JSON.stringify({ accountUuid: 'acct-uuid-1' })
    })
    harness.emit({
      type: 'receipt',
      receipt: { laneId: LANE_A, refreshTokenSha256: 'c'.repeat(64) }
    })
    await vi.waitFor(() => {
      expect(harness.rotatedWrites).toEqual([
        { accountId: 'acct-1', credentialsJson: '{"claudeAiOauth":{"accessToken":"at-2"}}' }
      ])
    })
  })

  // §3 row 2: `pullRotated` returns nothing when the sha matches. Sending a hard-coded null moved
  // a live refresh token across the wire on EVERY receipt; sending the receipt's own sha would
  // match every time and never pull the rotation back at all.
  it('pulls with the sha its own store holds, not null and not the receipt sha', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.emit({
      type: 'receipt',
      receipt: { laneId: LANE_A, refreshTokenSha256: 'c'.repeat(64) }
    })
    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.method === 'accounts.lane.pullRotated')).toBe(true)
    })
    expect(
      harness.calls.find((call) => call.method === 'accounts.lane.pullRotated')?.params
    ).toEqual({ knownRefreshTokenSha256: 'b'.repeat(64) })
  })

  it('reports a throwing frame handler instead of losing it as an unhandled rejection', async () => {
    const harness = makeClient({ failReadByClientRef: true })
    await harness.client.connect()
    harness.emit({ type: 'switch-requested', requestId: 'req-1', clientRef: 'ref-1' })
    await vi.waitFor(() => {
      expect(harness.refusals.map((entry) => entry.method)).toContain(
        'accounts.lane.statusSubscribe'
      )
    })
  })

  it('takes the lease from the published status, and a disconnect does not release it', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.emit({ type: 'status', status: STATUS() })
    expect(harness.leases.isDelegated('acct-1')).toBe(true)
    harness.client.disconnect()
    expect(harness.leases.isDelegated('acct-1')).toBe(true)
    expect(harness.isSubscribed()).toBe(false)
  })

  it('reports a refusal rather than throwing at the caller', async () => {
    const harness = makeClient({ failPush: true })
    expect(await harness.client.connect()).toBe('refused')
    expect(harness.refusals.map((entry) => entry.method)).toEqual(['accounts.lane.push'])
  })

  // Release-audit B3 follow-up: every ok status probe (settings hydration, the sidebar, opening
  // the hosts dropdown) calls `connect()` again, not just an actual reconnect.
  it('does not republish or repush on a second connect while already subscribed', async () => {
    const harness = makeClient()
    expect(await harness.client.connect()).toBe('pushed')
    harness.calls.length = 0
    expect(await harness.client.connect()).toBe('already-connected')
    expect(harness.calls).toEqual([])
    expect(harness.isSubscribed()).toBe(true)
  })

  it('republishes and repushes after a disconnect, then a fresh connect', async () => {
    const harness = makeClient()
    await harness.client.connect()
    harness.client.disconnect()
    harness.calls.length = 0
    expect(await harness.client.connect()).toBe('pushed')
    // No second `accounts.lane.status`: the delegation resolved by the first connect is cached
    // and survives a disconnect (only the subscription and `supported` cache are cleared).
    expect(harness.calls.map((call) => call.method)).toEqual([
      'accounts.lane.setDelegableAccounts',
      'accounts.lane.push'
    ])
    expect(harness.isSubscribed()).toBe(true)
  })

  it('coalesces concurrent connect() calls onto one subscribe/publish/push', async () => {
    const harness = makeClient()
    const [first, second] = await Promise.all([harness.client.connect(), harness.client.connect()])
    expect(first).toBe('pushed')
    expect(second).toBe('pushed')
    expect(harness.calls.map((call) => call.method)).toEqual([
      'accounts.lane.setDelegableAccounts',
      'accounts.lane.status',
      'accounts.lane.push'
    ])
  })
})
