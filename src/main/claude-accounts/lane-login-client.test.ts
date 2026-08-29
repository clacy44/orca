import { describe, expect, it, vi } from 'vitest'
import {
  LaneLoginClient,
  LaneLoginRefusedError,
  type LaneLoginCapabilityState
} from './lane-login-client'
import { AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { LaneLoginTransport } from './lane-login-transport'

function makeTransport(overrides: Partial<LaneLoginTransport> = {}): LaneLoginTransport {
  return {
    hostId: 'env-1',
    getCapabilities: vi.fn(async () => [AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY]),
    call: vi.fn(async () => ({})) as unknown as LaneLoginTransport['call'],
    subscribeStatus: vi.fn(async () => () => {}),
    ...overrides
  }
}

describe('LaneLoginClient', () => {
  it('reports unsupported when the host lacks the v2 capability (v1 alone is not enough)', async () => {
    const transport = makeTransport({
      getCapabilities: vi.fn(async () => ['agent.identity-lanes.v1'])
    })
    const client = new LaneLoginClient(transport)
    const state = await client.connect()
    expect(state).toBe('unsupported')
    expect(transport.subscribeStatus).not.toHaveBeenCalled()
  })

  it('subscribes only once the v2 capability is confirmed, and connect() is idempotent', async () => {
    const transport = makeTransport()
    const client = new LaneLoginClient(transport)
    await client.connect()
    await client.connect()
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
    expect(client.getCapabilityState()).toBe('supported')
  })

  it('loginStart passes expectedEmail through and returns the exact L1 shape', async () => {
    const call = vi.fn(async () => ({
      loginSessionId: 'sess-1',
      authorizeUrl: 'https://platform.claude.com/authorize?x=1',
      expiresAt: 1234
    }))
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const result = await client.loginStart('dev@example.com')
    expect(call).toHaveBeenCalledWith('accounts.lane.loginStart', {
      expectedEmail: 'dev@example.com'
    })
    expect(result.loginSessionId).toBe('sess-1')
    expect(result.authorizeUrl).toContain('platform.claude.com')
  })

  it('never re-requests or caches authorizeUrl on loginStatus — the shape has no such field', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'accounts.lane.loginStatus') {
        return { state: 'live', expiresAt: 1, attempts: 0, identity: null }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const status = await client.loginStatus('sess-1')
    expect(status).not.toHaveProperty('authorizeUrl')
  })

  it('wraps a refused call in a LaneLoginRefusedError carrying the host code+message', async () => {
    const call = vi.fn(async () => {
      throw { code: 'accounts.lane.login_not_designated', message: 'not designated' }
    })
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    await expect(client.loginStart('a@b.com')).rejects.toMatchObject({
      code: 'accounts.lane.login_not_designated',
      message: 'not designated'
    })
    await expect(client.loginStart('a@b.com')).rejects.toBeInstanceOf(LaneLoginRefusedError)
  })

  it('selectAccount resolves synchronously to {active}, never a pending intermediate state', async () => {
    const call = vi.fn(async () => ({ active: 'acct-1' }))
    const client = new LaneLoginClient(
      makeTransport({ call: call as unknown as LaneLoginTransport['call'] })
    )
    const result = await client.selectAccount('acct-1')
    expect(result).toEqual({ active: 'acct-1' })
  })

  it('dispatches login-started/-completed/-failed frames to their own callbacks', async () => {
    let deliver: (frame: unknown) => void = () => {}
    const transport = makeTransport({
      subscribeStatus: vi.fn(async (onFrame) => {
        deliver = onFrame as (frame: unknown) => void
        return () => {}
      })
    })
    const onLoginStarted = vi.fn()
    const onLoginCompleted = vi.fn()
    const onLoginFailed = vi.fn()
    const client = new LaneLoginClient(transport, {
      onLoginStarted,
      onLoginCompleted,
      onLoginFailed
    })
    await client.connect()
    deliver({ type: 'login-started', loginSessionId: 's1', expiresAt: 10 })
    deliver({ type: 'login-completed', loginSessionId: 's1', identity: { email: 'a@b.com' } })
    deliver({ type: 'login-failed', loginSessionId: 's2', code: 'x', message: 'y' })
    expect(onLoginStarted).toHaveBeenCalledWith('s1', 10)
    expect(onLoginCompleted).toHaveBeenCalledWith('s1', { email: 'a@b.com' })
    expect(onLoginFailed).toHaveBeenCalledWith('s2', 'x', 'y')
  })

  // Mutation proof: swapping the capability constant this client checks from v2 back to v1 must
  // turn the first test above red, because a v1-only host must never be treated as login-capable.
  it('MUTATION PROOF: checking only v1 would wrongly accept a v1-only host', async () => {
    const v1Only = ['agent.identity-lanes.v1']
    expect(v1Only.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)).toBe(false)
  })

  it('re-entrant notifyHostReachable during a probe joins the same probe, not a second one', async () => {
    // getCapabilities synchronously fires a second connect() (mirrors
    // runtime-environment-transport-routing.ts's notifyLaneLoginHostReachable, which fires
    // on every status.get, calling back into connect() while the first probe is still in flight).
    let capturedClient: LaneLoginClient | undefined
    const getCapabilities = vi.fn(async () => {
      // Re-entrant call while this promise is still pending, before `unsubscribe` is set.
      void capturedClient?.connect()
      return [AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY]
    })
    const transport = makeTransport({ getCapabilities })
    const client = new LaneLoginClient(transport)
    capturedClient = client
    await client.connect()
    expect(getCapabilities).toHaveBeenCalledTimes(1)
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
  })

  // Mutation proof: this reproduces the OLD `connect()` body (no `connecting` single-flight
  // guard — the exact shape this client had before the fix, matching the defect report's "sets
  // 'checking' and starts ANOTHER getCapabilities → another status.get → another notify →
  // unbounded loop") against the identical re-entrant scenario above. Unlike the fixed client
  // (exactly 1 call, proven above), the unguarded version re-probes on every re-entrant reachable
  // signal with nothing to stop it — here capped at 5 re-entries only so the test itself
  // terminates; production has no such cap, which is the live defect.
  it('MUTATION PROOF: the pre-fix connect() (no single-flight guard) re-probes without bound', async () => {
    const REENTRY_CAP = 5
    class UnguardedClient {
      unsub: (() => void) | null = null
      constructor(private readonly transport: LaneLoginTransport) {}
      async connect(): Promise<void> {
        if (this.unsub) {
          return
        }
        const capabilities = await this.transport.getCapabilities()
        if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
          return
        }
        this.unsub = await this.transport.subscribeStatus(() => {})
      }
    }
    let capturedClient: UnguardedClient | undefined
    let reentries = 0
    const getCapabilities = vi.fn(async () => {
      // Re-entrant call while this probe is still in flight (`unsub` not yet set) — exactly
      // `notifyLaneLoginHostReachable`'s real shape, capped here only to keep the test finite.
      if (reentries < REENTRY_CAP) {
        reentries += 1
        void capturedClient?.connect()
      }
      return [AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY]
    })
    const transport = makeTransport({ getCapabilities })
    const client = new UnguardedClient(transport)
    capturedClient = client
    await client.connect()
    await vi.waitFor(() => expect(getCapabilities.mock.calls.length).toBeGreaterThan(REENTRY_CAP))
    // Every re-entry started its OWN probe (and, since each sees an unset `unsub`, its own
    // subscribe) — the single-flight guard is what collapses this to exactly one of each.
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(REENTRY_CAP + 1)
  })

  it("does not flash 'checking' on reconnect after an 'end' frame, and reconnects silently", async () => {
    vi.useFakeTimers()
    try {
      let deliver: (frame: unknown) => void = () => {}
      let subscribeCount = 0
      const transport = makeTransport({
        subscribeStatus: vi.fn(async (onFrame) => {
          subscribeCount += 1
          deliver = onFrame as (frame: unknown) => void
          return () => {}
        })
      })
      const onCapabilityChanged = vi.fn()
      const client = new LaneLoginClient(transport, { onCapabilityChanged })
      await client.connect()
      expect(client.getCapabilityState()).toBe('supported')
      onCapabilityChanged.mockClear()

      deliver({ type: 'end' })
      // 'end' must never itself flip capability back to 'checking' or 'unknown'.
      expect(onCapabilityChanged).not.toHaveBeenCalled()
      expect(client.getCapabilityState()).toBe('supported')

      await vi.advanceTimersByTimeAsync(1_000)
      // The scheduled silent reconnect ran and re-subscribed, without ever visiting 'checking'.
      expect(subscribeCount).toBe(2)
      expect(onCapabilityChanged).not.toHaveBeenCalledWith('checking')
      expect(client.getCapabilityState()).toBe('supported')
    } finally {
      vi.useRealTimers()
    }
  })

  // Mutation proof: this reproduces the OLD `connect()` body, which unconditionally set
  // 'checking' on every call (the pre-fix shape), against the identical reconnect-after-'end'
  // scenario above, and shows it DOES flash 'checking' — proving the "only from 'unknown'" guard
  // is what keeps the preceding test's row from flapping.
  it("MUTATION PROOF: the pre-fix connect() (always sets 'checking') flashes on reconnect", async () => {
    const seen: LaneLoginCapabilityState[] = []
    class AlwaysCheckingClient {
      capability: LaneLoginCapabilityState = 'unknown'
      unsub: (() => void) | null = null
      constructor(private readonly transport: LaneLoginTransport) {}
      set(next: LaneLoginCapabilityState): void {
        this.capability = next
        seen.push(next)
      }
      async connect(): Promise<void> {
        if (this.unsub) {
          return
        }
        this.set('checking') // pre-fix: unconditional, not gated on 'unknown'
        const capabilities = await this.transport.getCapabilities()
        if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
          this.set('unsupported')
          return
        }
        this.set('supported')
        this.unsub = await this.transport.subscribeStatus((frame: unknown) => {
          if ((frame as { type: string }).type === 'end') {
            this.unsub = null
            void this.connect()
          }
        })
      }
    }
    const transport = makeTransport()
    const client = new AlwaysCheckingClient(transport)
    await client.connect()
    seen.length = 0
    const deliver = (transport.subscribeStatus as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      frame: unknown
    ) => void
    deliver({ type: 'end' })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toContain('checking')
  })

  it('a successful ready frame populates the snapshot from the subscribe payload alone', async () => {
    let deliver: (frame: unknown) => void = () => {}
    const transport = makeTransport({
      subscribeStatus: vi.fn(async (onFrame) => {
        deliver = onFrame as (frame: unknown) => void
        return () => {}
      })
    })
    const onStatusChanged = vi.fn()
    const onAccountsChanged = vi.fn()
    const client = new LaneLoginClient(transport, { onStatusChanged, onAccountsChanged })
    await client.connect()
    deliver({
      type: 'ready',
      subscriptionId: 'sub-1',
      status: {
        laneState: 'loaded',
        callerIsDelegatedGrant: true,
        accounts: [{ laneAccountId: 'a1', email: 'a@b.com', label: null, active: true }],
        delegatedGrantId: 'device-1'
      }
    })
    expect(onStatusChanged).toHaveBeenCalledWith({
      laneState: 'loaded',
      callerIsDelegatedGrant: true,
      accounts: [{ laneAccountId: 'a1', email: 'a@b.com', label: null, active: true }]
    })
    expect(onAccountsChanged).toHaveBeenCalledTimes(1)
    expect(transport.call).not.toHaveBeenCalled()
  })

  // BLOCKER 1 (adversarial review): disconnect() firing while subscribeStatus() is still in
  // flight used to be a no-op — `unsubscribe` was still null, so disconnect() had nothing to tear
  // down — and the late resolve then stored a live subscription nothing would ever close.
  it('disconnect() mid-subscribe: the late subscription tears itself down, not stored', async () => {
    let resolveSubscribe!: (unsub: () => void) => void
    const subscribePromise = new Promise<() => void>((resolve) => {
      resolveSubscribe = resolve
    })
    const lateUnsub = vi.fn()
    const transport = makeTransport({
      subscribeStatus: vi.fn(() => subscribePromise)
    })
    const client = new LaneLoginClient(transport)
    const connectPromise = client.connect()
    // Let getCapabilities settle so doConnect is now parked on the pending subscribeStatus().
    await Promise.resolve()
    await Promise.resolve()
    client.disconnect()
    resolveSubscribe(lateUnsub)
    await connectPromise
    expect(lateUnsub).toHaveBeenCalledTimes(1)
    // The late subscription was never retained: a fresh connect() opens its own, second one.
    await client.connect()
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(2)
  })

  // Review round 2 (major): connect() right after disconnect(), while the retired generation's
  // probe is still in flight, must start a FRESH probe — not join the abandoned one, whose
  // doConnect() bails on the generation mismatch and would leave the client parked at 'checking'
  // with no subscription and no retry. This is exactly the Refresh action (disconnect → connect).
  it('connect() after disconnect() during an in-flight probe starts a fresh probe and subscribes', async () => {
    let resolveFirstProbe!: (caps: readonly string[]) => void
    const firstProbe = new Promise<readonly string[]>((resolve) => {
      resolveFirstProbe = resolve
    })
    let probes = 0
    const transport = makeTransport({
      getCapabilities: vi.fn(async () => {
        probes += 1
        return probes === 1 ? firstProbe : [AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY]
      })
    })
    const client = new LaneLoginClient(transport)
    const stale = client.connect() // gen 1, parked on the pending first probe
    client.disconnect() // gen 2
    const fresh = client.connect() // must NOT join `stale`
    expect(transport.getCapabilities).toHaveBeenCalledTimes(2)
    expect(await fresh).toBe('supported')
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
    // The retired probe resolving late changes nothing: no second subscription, state stays.
    resolveFirstProbe([AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY])
    await stale
    expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
    expect(client.getCapabilityState()).toBe('supported')
  })

  // Mutation proof: a disconnect() that does NOT drop `connecting` (the round-1 shape) makes the
  // second connect() join the retired probe — one getCapabilities call, no subscription, and the
  // client stuck at 'checking' once the stale probe resolves.
  it('MUTATION PROOF: a disconnect() that keeps the in-flight probe strands connect() at checking', async () => {
    let resolveFirstProbe!: (caps: readonly string[]) => void
    const firstProbe = new Promise<readonly string[]>((resolve) => {
      resolveFirstProbe = resolve
    })
    const getCapabilities = vi.fn(async () => firstProbe)
    let generation = 0
    let connecting: Promise<string> | null = null
    let unsubscribe: (() => void) | null = null
    let subscribes = 0
    const mutant = {
      async connect(): Promise<string> {
        if (unsubscribe) {
          return 'supported'
        }
        if (connecting) {
          return connecting // joins regardless of generation — the bug
        }
        const gen = ++generation
        connecting = (async () => {
          await getCapabilities()
          if (gen !== generation) {
            return 'checking'
          }
          subscribes += 1
          unsubscribe = () => {}
          return 'supported'
        })()
        try {
          return await connecting
        } finally {
          connecting = null
        }
      },
      disconnect(): void {
        generation++ // ...but `connecting` is left in place
      }
    }
    const stale = mutant.connect()
    mutant.disconnect()
    const fresh = mutant.connect()
    expect(getCapabilities).toHaveBeenCalledTimes(1) // joined, no fresh probe
    resolveFirstProbe([AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY])
    expect(await fresh).toBe('checking') // stranded
    expect(await stale).toBe('checking')
    expect(subscribes).toBe(0)
  })

  // Mutation proof: reproduces doConnect() WITHOUT the post-await generation re-check after
  // subscribeStatus() (the pre-fix shape) against the identical race above — the late
  // subscription's unsubscribe is never invoked, because nothing schedules the teardown.
  it('MUTATION PROOF: without the post-subscribe generation check, the late unsub is never called', async () => {
    let resolveSubscribe!: (unsub: () => void) => void
    const subscribePromise = new Promise<() => void>((resolve) => {
      resolveSubscribe = resolve
    })
    const lateUnsub = vi.fn()
    const transport = makeTransport({
      subscribeStatus: vi.fn(() => subscribePromise)
    })
    class NoPostSubscribeCheckClient {
      unsub: (() => void) | null = null
      generation = 0
      constructor(private readonly t: LaneLoginTransport) {}
      async connect(): Promise<void> {
        if (this.unsub) {
          return
        }
        this.generation += 1
        const capabilities = await this.t.getCapabilities()
        if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
          return
        }
        // Pre-fix: no re-check of `gen` here before storing the result.
        this.unsub = await this.t.subscribeStatus(() => {})
      }
      disconnect(): void {
        this.generation += 1
        this.unsub?.()
        this.unsub = null
      }
    }
    const client = new NoPostSubscribeCheckClient(transport)
    const connectPromise = client.connect()
    await Promise.resolve()
    await Promise.resolve()
    client.disconnect()
    resolveSubscribe(lateUnsub)
    await connectPromise
    expect(lateUnsub).not.toHaveBeenCalled()
  })

  // BLOCKER 2 (adversarial review): an 'end' frame delivered through the OLD subscription's
  // onFrame closure, arriving AFTER disconnect() already ran, used to still schedule a reconnect
  // — reconnecting to a host that was just removed (re-pair/removal racing the reachable hook).
  it("disconnect() then a late 'end' on the stale closure schedules no reconnect", async () => {
    vi.useFakeTimers()
    try {
      let deliver: (frame: unknown) => void = () => {}
      const transport = makeTransport({
        subscribeStatus: vi.fn(async (onFrame) => {
          deliver = onFrame as (frame: unknown) => void
          return () => {}
        })
      })
      const client = new LaneLoginClient(transport)
      await client.connect()
      expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
      client.disconnect()
      // The stale closure still fires — this is the exact race: the host tears the subscription
      // down asynchronously, and its 'end' frame lands after disconnect() already ran.
      deliver({ type: 'end' })
      await vi.advanceTimersByTimeAsync(35_000)
      expect(transport.subscribeStatus).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // Mutation proof: reproduces handleFrame WITHOUT the closure's own generation check (the
  // pre-fix shape) against the identical race above — the late 'end' schedules a reconnect that
  // DOES fire 35s later.
  it("MUTATION PROOF: without the closure's generation check, the late 'end' reconnects anyway", async () => {
    vi.useFakeTimers()
    try {
      let deliver: (frame: unknown) => void = () => {}
      const transport = makeTransport({
        subscribeStatus: vi.fn(async (onFrame) => {
          deliver = onFrame as (frame: unknown) => void
          return () => {}
        })
      })
      class NoClosureCheckClient {
        unsub: (() => void) | null = null
        generation = 0
        constructor(private readonly t: LaneLoginTransport) {}
        async connect(): Promise<void> {
          if (this.unsub) {
            return
          }
          this.generation += 1
          const capabilities = await this.t.getCapabilities()
          if (!capabilities.includes(AGENT_IDENTITY_LANES_V2_RUNTIME_CAPABILITY)) {
            return
          }
          this.unsub = await this.t.subscribeStatus((frame: unknown) => this.handleFrame(frame))
        }
        // Pre-fix: no generation check at the top — a stale closure's frame is still processed.
        handleFrame(frame: unknown): void {
          if ((frame as { type: string }).type === 'end') {
            this.unsub = null
            setTimeout(() => void this.connect(), 1_000)
          }
        }
        disconnect(): void {
          this.generation += 1
          this.unsub?.()
          this.unsub = null
        }
      }
      const client = new NoClosureCheckClient(transport)
      await client.connect()
      client.disconnect()
      deliver({ type: 'end' })
      await vi.advanceTimersByTimeAsync(35_000)
      expect(transport.subscribeStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
