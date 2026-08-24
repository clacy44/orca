import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { Store } from '../persistence'
import {
  attachLaneDelegationLeaseStore,
  getLaneDelegationLeaseStore
} from './lane-delegation-lease'

type HostClientStub = {
  handlers: Record<string, (params?: unknown) => unknown>
  getCapabilities: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  subscribeLaneStatus: ReturnType<typeof vi.fn>
}

const STATUS: ClaudeLaneStatus = {
  laneId: 'p-ana',
  laneState: 'absent',
  delegatedGrantId: 'this-desktop',
  callerIsDelegatedGrant: true,
  heldDisplayName: null,
  heldIdentity: null,
  refreshTokenSha256: null,
  expiresAt: null,
  delegable: []
}

const { hostClients, createHostClientMock } = vi.hoisted(() => {
  const hostClients = new Map<string, HostClientStub>()
  const createHostClientMock = vi.fn((environmentId: string): HostClientStub => {
    const entry: HostClientStub = {
      handlers: {
        'accounts.lane.status': () => STATUS,
        'accounts.lane.setDelegableAccounts': () => ({}),
        'accounts.lane.push': () => ({ refreshTokenSha256: 'b'.repeat(64) })
      },
      getCapabilities: vi.fn().mockResolvedValue(['agent.identity-lanes.v1']),
      call: vi.fn((method: string, params?: unknown) =>
        Promise.resolve(entry.handlers[method]?.(params))
      ),
      subscribeLaneStatus: vi.fn().mockResolvedValue(vi.fn())
    }
    hostClients.set(environmentId, entry)
    return entry
  })
  return { hostClients, createHostClientMock }
})

vi.mock('./lane-delegation-host-client', () => ({
  createLaneDelegationHostClient: createHostClientMock
}))

vi.mock('./managed-auth-path', () => ({
  resolveOwnedClaudeManagedAuthPath: vi.fn((accountId: string) => `/managed/${accountId}`),
  readClaudeManagedAuthFile: vi.fn((_path: string, filename: string) =>
    filename === '.credentials.json'
      ? JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
      : JSON.stringify({ emailAddress: 'ana@corp.test' })
  ),
  writeClaudeManagedAuthFile: vi.fn()
}))

vi.mock('./runtime-paths', () => ({
  ClaudeRuntimePathResolver: vi
    .fn()
    .mockImplementation(
      function ClaudeRuntimePathResolver(this: { getRuntimePaths: () => unknown }) {
        this.getRuntimePaths = () => ({
          configDir: '/home/x/.claude',
          credentialsPath: '/home/x/.claude/.credentials.json',
          configPath: '/home/x/.claude.json',
          envPatch: {}
        })
      }
    )
}))

vi.mock('./runtime-credential-lane-clearing', () => ({
  clearRuntimeCredentialsForDelegatedAccount: vi.fn()
}))

vi.mock('./keychain', () => ({ deleteActiveClaudeKeychainCredentials: vi.fn() }))

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: vi.fn().mockReturnValue([{ id: 'env-1', name: 'Office Mac' }])
}))

// Imported after the mocks above so the module under test picks them up.
import {
  delegateAccountToLaneHost,
  listDelegableLaneHosts,
  notifyLaneDelegationHostReachable,
  notifyLaneDelegationHostUnreachable,
  resetLaneDelegationDesktopServiceForTest,
  startLaneDelegationDesktopService
} from './lane-delegation-desktop-service'

function makeStore(): Store & {
  emitSettingsChanged: (updates: Record<string, unknown>) => void
} {
  const settings = {
    claudeManagedAccounts: [
      {
        id: 'acct-1',
        email: 'ana@corp.test',
        managedAuthPath: '/managed/acct-1',
        authMethod: 'subscription-oauth' as const,
        createdAt: 0,
        updatedAt: 0,
        lastAuthenticatedAt: 0
      }
    ],
    activeClaudeManagedAccountId: 'acct-1',
    activeClaudeManagedAccountIdsByRuntime: undefined
  }
  let leases: ClaudeLaneDelegationLease[] = []
  const listeners: ((updates: Record<string, unknown>) => void)[] = []
  return {
    getSettings: () => settings,
    onSettingsChanged: (listener: (updates: Record<string, unknown>) => void) => {
      listeners.push(listener)
      return () => {}
    },
    getClaudeLaneDelegationLeases: () => leases,
    setClaudeLaneDelegationLeases: (rows: readonly ClaudeLaneDelegationLease[]) => {
      leases = [...rows]
    },
    emitSettingsChanged: (updates: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener(updates)
      }
    }
  } as unknown as Store & { emitSettingsChanged: (updates: Record<string, unknown>) => void }
}

/** Flushes the task queue enough times for `connect()`'s awaited chain to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('LaneDelegationDesktopService', () => {
  beforeEach(() => {
    hostClients.clear()
    createHostClientMock.mockClear()
  })
  afterEach(() => {
    resetLaneDelegationDesktopServiceForTest()
    attachLaneDelegationLeaseStore(null)
  })

  it('attaches the lease store on construction, arming the delegated-elsewhere guards', () => {
    expect(getLaneDelegationLeaseStore()).toBeNull()
    startLaneDelegationDesktopService({ store: makeStore() })
    expect(getLaneDelegationLeaseStore()).not.toBeNull()
  })

  it('reconnect creates one client per host and pushes the current selection', async () => {
    startLaneDelegationDesktopService({ store: makeStore() })
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    const host = hostClients.get('env-1')
    expect(host).toBeDefined()
    expect(host!.subscribeLaneStatus).toHaveBeenCalledTimes(1)
    expect(host!.call).toHaveBeenCalledWith(
      'accounts.lane.push',
      expect.objectContaining({
        envelope: expect.objectContaining({ displayName: 'ana@corp.test' })
      })
    )
    // Reconnecting the same host must not mint a second client.
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    expect(createHostClientMock).toHaveBeenCalledTimes(1)
  })

  it('a selection change re-pushes to every connected host', async () => {
    const store = makeStore()
    startLaneDelegationDesktopService({ store })
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    const host = hostClients.get('env-1')!
    host.call.mockClear()
    store.emitSettingsChanged({ activeClaudeManagedAccountId: 'acct-1' })
    await flush()
    expect(host.call).toHaveBeenCalledWith('accounts.lane.push', expect.anything())
  })

  it('disconnect closes the status subscription without releasing the lease store', async () => {
    startLaneDelegationDesktopService({ store: makeStore() })
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    const unsubscribe = await hostClients.get('env-1')!.subscribeLaneStatus.mock.results[0]!.value
    expect(unsubscribe).toHaveBeenCalledTimes(0)
    notifyLaneDelegationHostUnreachable('env-1')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    // §2e: a drop never un-suppresses — the attached lease store must still be reachable.
    expect(getLaneDelegationLeaseStore()).not.toBeNull()
  })

  // Release-audit B3 follow-up: an explicit "Disconnect" was silently undone by the next
  // unrelated selection change — a Claude account switch reconnected the closed client and
  // pushed a credential to it.
  it('a selection change does not reconnect or push to a host the user explicitly disconnected', async () => {
    const store = makeStore()
    startLaneDelegationDesktopService({ store })
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    const host = hostClients.get('env-1')!
    notifyLaneDelegationHostUnreachable('env-1')
    host.call.mockClear()
    host.subscribeLaneStatus.mockClear()

    store.emitSettingsChanged({ activeClaudeManagedAccountId: 'acct-1' })
    await flush()

    expect(host.call).not.toHaveBeenCalled()
    expect(host.subscribeLaneStatus).not.toHaveBeenCalled()
  })

  it('the explicit delegate action pushes the named account onto the named host', async () => {
    startLaneDelegationDesktopService({ store: makeStore() })
    const delegated = await delegateAccountToLaneHost('env-1', 'acct-1')
    expect(delegated).toBe(true)
    const host = hostClients.get('env-1')!
    expect(host.call).toHaveBeenCalledWith(
      'accounts.lane.push',
      expect.objectContaining({
        envelope: expect.objectContaining({ displayName: 'ana@corp.test' })
      })
    )
  })

  it('the delegate action reports false for an unknown account without calling the host', async () => {
    startLaneDelegationDesktopService({ store: makeStore() })
    const delegated = await delegateAccountToLaneHost('env-1', 'no-such-account')
    expect(delegated).toBe(false)
    expect(createHostClientMock).toHaveBeenCalledTimes(0)
  })

  it('lists a connected host as delegable once its lane names this grant as the pusher', async () => {
    startLaneDelegationDesktopService({ store: makeStore() })
    expect(listDelegableLaneHosts('/tmp/userdata')).toEqual([])
    notifyLaneDelegationHostReachable('env-1')
    await flush()
    expect(listDelegableLaneHosts('/tmp/userdata')).toEqual([
      { environmentId: 'env-1', label: 'Office Mac', laneId: 'p-ana', laneState: 'absent' }
    ])
  })

  it('with no active service, the module-level helpers are safe no-ops', async () => {
    expect(await delegateAccountToLaneHost('env-1', 'acct-1')).toBe(false)
    expect(listDelegableLaneHosts('/tmp/userdata')).toEqual([])
    expect(() => notifyLaneDelegationHostReachable('env-1')).not.toThrow()
    expect(() => notifyLaneDelegationHostUnreachable('env-1')).not.toThrow()
  })
})
