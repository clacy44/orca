// R315 (T1): the adapter turns an UNPLANNED transport loss into one proactive, single-flight
// recovery — respawn if the daemon is gone, one authoritative listSessions on the healthy
// replacement, and only then announce which sessions died with the daemon. Fake client, so the
// order of events is observable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeDaemonClient {
    static last: FakeDaemonClient
    connected = true
    gone = false
    disconnectedListeners = new Set<() => void>()
    aliveSessionIds: string[] = []
    listSessionsImpl: (() => Promise<unknown>) | null = null
    log: string[] = []
    constructor(_opts: unknown) {
      FakeDaemonClient.last = this
    }
    onDisconnected(cb: () => void): () => void {
      this.disconnectedListeners.add(cb)
      return () => this.disconnectedListeners.delete(cb)
    }
    onEvent(_cb: unknown): () => void {
      return () => {}
    }
    isConnected(): boolean {
      return this.connected
    }
    async ensureConnected(): Promise<void> {
      if (this.gone) {
        throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT', syscall: 'connect' })
      }
      this.connected = true
    }
    async ensureConnectedWithin(_ms: number): Promise<void> {
      return this.ensureConnected()
    }
    async request(method: string): Promise<unknown> {
      if (method === 'getSize') {
        return { size: { cols: 80, rows: 24 } }
      }
      if (method === 'createOrAttach') {
        return { isNew: false, incarnationId: 'inc-att' }
      }
      if (method !== 'listSessions') {
        return undefined
      }
      this.log.push('listSessions')
      if (this.listSessionsImpl) {
        return this.listSessionsImpl()
      }
      return { sessions: this.aliveSessionIds.map((sessionId) => ({ sessionId, isAlive: true })) }
    }
    notify(): void {}
    disconnect(): void {
      this.connected = false
    }
    getDaemonIdentity(): null {
      return null
    }
    hasObservedAuthenticatedDisconnect(): boolean {
      return false
    }
    /** A crash: the socket closes and the endpoint is gone until the adapter respawns it. */
    crash(): void {
      this.connected = false
      this.gone = true
      for (const cb of this.disconnectedListeners) {
        cb()
      }
    }
    /** A transient drop: the socket closes but the daemon is still there. */
    drop(): void {
      this.connected = false
      for (const cb of this.disconnectedListeners) {
        cb()
      }
    }
  }
  return { FakeDaemonClient }
})

vi.mock('./client', () => ({ DaemonClient: h.FakeDaemonClient }))

import {
  DaemonPtyAdapter,
  _resetDaemonLossEpochSequenceForTests,
  type DaemonPtyAdapterOptions
} from './daemon-pty-adapter'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'

type Lost = { epoch: number; sessions: { id: string; incarnationId?: string }[] }

let adapter: DaemonPtyAdapter | undefined
let fake: InstanceType<typeof h.FakeDaemonClient>
let order: string[]
let lost: Lost[]
let breadcrumbs: { name: string; data: Record<string, unknown> }[]

function makeAdapter(
  extra: Partial<DaemonPtyAdapterOptions> = {},
  respawn?: DaemonPtyAdapterOptions['respawn']
): DaemonPtyAdapter {
  const created = new DaemonPtyAdapter({
    socketPath: '/tmp/fake.sock',
    tokenPath: '/tmp/fake.token',
    respawn:
      respawn ??
      (async () => {
        order.push('respawn')
        fake.gone = false
      }),
    recordBreadcrumb: (name, data) => breadcrumbs.push({ name, data }),
    ...extra
  })
  fake = h.FakeDaemonClient.last
  // The in-test "inventory" records its call order against the respawn marker.
  const originalRequest = fake.request.bind(fake)
  fake.request = async (method: string) => {
    if (method === 'listSessions') {
      order.push('listSessions')
    }
    return originalRequest(method)
  }
  created.onSessionsLostToDaemonDeath((event) => {
    order.push('emit')
    lost.push(event)
  })
  adapter = created
  return created
}

function seedActive(target: DaemonPtyAdapter, ids: string[]): void {
  const internals = target as unknown as {
    activeSessionIds: Set<string>
    sessionIncarnations: Map<string, string>
  }
  for (const id of ids) {
    internals.activeSessionIds.add(id)
    internals.sessionIncarnations.set(id, `inc-${id}`)
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  _resetDaemonLossEpochSequenceForTests()
  order = []
  lost = []
  breadcrumbs = []
})

afterEach(() => {
  adapter?.dispose()
  adapter = undefined
  vi.useRealTimers()
})

describe('DaemonPtyAdapter proactive daemon-loss recovery (R315)', () => {
  it('after a crash with 2 sessions: respawns exactly once, then inventories, then emits both ids once', async () => {
    const respawn = vi.fn(async () => {
      order.push('respawn')
      fake.gone = false
    })
    const a = makeAdapter({}, respawn)
    seedActive(a, ['s1', 's2'])
    fake.aliveSessionIds = []

    fake.crash()
    await flush()

    expect(respawn).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['respawn', 'listSessions', 'emit'])
    expect(lost).toHaveLength(1)
    expect(lost[0]?.sessions).toEqual([
      { id: 's1', incarnationId: 'inc-s1' },
      { id: 's2', incarnationId: 'inc-s2' }
    ])
    expect(lost[0]?.epoch).toBe(1)
    // Lost ids deliberately stay in the adapter's active set (the lazy 03:10Z backstop).
    expect(a.getActiveSessionIds().sort()).toEqual(['s1', 's2'])
  })

  it('emits only the sessions the healthy replacement does not report alive', async () => {
    const a = makeAdapter()
    seedActive(a, ['s1', 's2'])
    fake.aliveSessionIds = ['s2']

    fake.crash()
    await flush()

    expect(lost[0]?.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('a transient drop with both sessions alive: no respawn, no emit', async () => {
    const respawn = vi.fn(async () => {})
    const a = makeAdapter({}, respawn)
    seedActive(a, ['s1', 's2'])
    fake.aliveSessionIds = ['s1', 's2']

    fake.drop()
    await flush()

    expect(respawn).not.toHaveBeenCalled()
    expect(order).toEqual(['listSessions'])
    expect(lost).toEqual([])
  })

  it('a write during recovery still yields one respawn and one emit', async () => {
    let releaseRespawn!: () => void
    const respawn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRespawn = () => {
            fake.gone = false
            resolve()
          }
        })
    )
    const a = makeAdapter({}, respawn)
    seedActive(a, ['s1'])
    fake.aliveSessionIds = []

    fake.crash()
    await flush()
    expect(() => a.write('s1', 'typed')).toThrow(PtyWriteUnavailableError)
    await flush()
    releaseRespawn()
    await flush()

    expect(respawn).toHaveBeenCalledTimes(1)
    expect(lost).toHaveLength(1)
  })

  it('with zero active sessions there is no recovery (a restart clears them first)', async () => {
    const respawn = vi.fn(async () => {})
    makeAdapter({}, respawn)

    fake.crash()
    await flush()

    expect(respawn).not.toHaveBeenCalled()
    expect(order).toEqual([])
    expect(lost).toEqual([])
  })

  it('does nothing while isRecoverySuppressed reports true', async () => {
    const respawn = vi.fn(async () => {})
    const a = makeAdapter({ isRecoverySuppressed: () => true }, respawn)
    seedActive(a, ['s1'])

    fake.crash()
    await flush()

    expect(respawn).not.toHaveBeenCalled()
    expect(lost).toEqual([])
  })

  it('does nothing on an adapter that cannot respawn', async () => {
    const a = new DaemonPtyAdapter({
      socketPath: '/tmp/fake.sock',
      tokenPath: '/tmp/fake.token',
      recordBreadcrumb: (name, data) => breadcrumbs.push({ name, data })
    })
    adapter = a
    fake = h.FakeDaemonClient.last
    a.onSessionsLostToDaemonDeath((event) => lost.push(event))
    seedActive(a, ['s1'])

    fake.crash()
    await flush()

    expect(fake.log).toEqual([])
    expect(lost).toEqual([])
  })

  it('never declares a loss on an unknown inventory: listSessions failing every time emits nothing and writes a breadcrumb', async () => {
    vi.useFakeTimers()
    const a = makeAdapter()
    seedActive(a, ['s1'])
    fake.listSessionsImpl = async () => {
      throw new Error('inventory unavailable')
    }

    fake.crash()
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(order.filter((step) => step === 'listSessions')).toHaveLength(4)
    expect(lost).toEqual([])
    expect(breadcrumbs.map((b) => b.name)).toEqual(['daemon_loss_recovery_unproven'])
  })

  it('recovers when a retry of the inventory succeeds', async () => {
    vi.useFakeTimers()
    const a = makeAdapter()
    seedActive(a, ['s1'])
    let calls = 0
    fake.listSessionsImpl = async () => {
      calls += 1
      if (calls === 1) {
        throw new Error('not ready yet')
      }
      return { sessions: [] }
    }

    fake.crash()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(lost).toHaveLength(1)
    expect(breadcrumbs).toEqual([])
  })

  it('disposing during recovery emits nothing', async () => {
    let releaseRespawn!: () => void
    const respawn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRespawn = () => {
            fake.gone = false
            resolve()
          }
        })
    )
    const a = makeAdapter({}, respawn)
    seedActive(a, ['s1'])

    fake.crash()
    await flush()
    a.dispose()
    releaseRespawn()
    await flush()

    expect(lost).toEqual([])
  })

  it('suppresses proactive recovery on a 4th death within 15 minutes (crash-loop breaker)', async () => {
    const respawn = vi.fn(async () => {
      fake.gone = false
    })
    const a = makeAdapter({}, respawn)
    for (let death = 1; death <= 3; death += 1) {
      seedActive(a, [`s${death}`])
      fake.aliveSessionIds = []
      fake.crash()
      await flush()
      expect(lost).toHaveLength(death)
    }

    seedActive(a, ['s4'])
    fake.crash()
    await flush()

    expect(respawn).toHaveBeenCalledTimes(3)
    expect(lost).toHaveLength(3)
    expect(breadcrumbs.map((b) => b.name)).toEqual(['daemon_loss_recovery_suppressed'])
  })

  it('numbers each death epoch and re-arms after the breaker window passes', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const a = makeAdapter()
    for (let death = 1; death <= 3; death += 1) {
      seedActive(a, [`s${death}`])
      fake.aliveSessionIds = []
      fake.crash()
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(lost.map((event) => event.epoch)).toEqual([1, 2, 3])

    await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
    seedActive(a, ['s9'])
    fake.crash()
    await vi.advanceTimersByTimeAsync(1)

    expect(lost.map((event) => event.epoch)).toEqual([1, 2, 3, 4])
  })

  describe('F2: a casualty is decided by explicit teardown, not by activeSessionIds', () => {
    function failFirstInventory(): void {
      let calls = 0
      fake.listSessionsImpl = async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('not ready yet')
        }
        return { sessions: [] }
      }
    }

    it('still announces a casualty whose id a concurrent listProcesses pruned from activeSessionIds', async () => {
      vi.useFakeTimers()
      const a = makeAdapter()
      seedActive(a, ['s1'])
      failFirstInventory()

      fake.crash()
      await vi.advanceTimersByTimeAsync(0)
      await a.listProcesses()
      expect(a.getActiveSessionIds()).toEqual([])
      await vi.advanceTimersByTimeAsync(2_000)

      expect(lost).toHaveLength(1)
      expect(lost[0]?.sessions).toEqual([{ id: 's1', incarnationId: 'inc-s1' }])
      expect(breadcrumbs).toEqual([])
    })

    it('does not announce a session explicitly shut down meanwhile, and records the breadcrumb', async () => {
      vi.useFakeTimers()
      const a = makeAdapter()
      seedActive(a, ['s1'])
      failFirstInventory()

      fake.crash()
      await vi.advanceTimersByTimeAsync(0)
      await a.shutdown('s1', { immediate: true })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(lost).toEqual([])
      expect(breadcrumbs).toEqual([
        { name: 'daemon_loss_candidates_torn_down', data: { count: 1 } }
      ])
    })
  })

  it('F4: an attached session is announced with the incarnation attach recorded', async () => {
    const a = makeAdapter()
    await a.attach('s1')
    fake.aliveSessionIds = []

    fake.crash()
    await flush()

    expect(lost[0]?.sessions).toEqual([{ id: 's1', incarnationId: 'inc-att' }])
  })

  it('F6: an announced session is not re-announced by later drops, and does not consume breaker slots', async () => {
    const a = makeAdapter()
    seedActive(a, ['s1'])
    fake.aliveSessionIds = []
    fake.crash()
    await flush()
    for (let drop = 0; drop < 3; drop += 1) {
      fake.drop()
      await flush()
    }

    seedActive(a, ['s2'])
    fake.crash()
    await flush()

    expect(lost.map((event) => event.sessions.map((session) => session.id))).toEqual([
      ['s1'],
      ['s2']
    ])
    expect(breadcrumbs.map((b) => b.name)).not.toContain('daemon_loss_recovery_suppressed')
  })

  it('F8: epochs are one monotonic sequence across adapters, so a replacement adapter never repeats one', async () => {
    const first = makeAdapter()
    seedActive(first, ['s1'])
    fake.aliveSessionIds = []
    fake.crash()
    await flush()
    first.dispose()

    const second = makeAdapter()
    seedActive(second, ['s1'])
    fake.aliveSessionIds = []
    fake.crash()
    await flush()

    expect(lost.map((event) => event.epoch)).toEqual([1, 2])
  })
})
