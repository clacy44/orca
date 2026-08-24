import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchManagedAccountUsage } from './claude-fetcher'
import { fetchViaPty } from './claude-pty'
import {
  LaneDelegationLeaseStore,
  attachLaneDelegationLeaseStore
} from '../claude-accounts/lane-delegation-lease'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'

/**
 * §2e rules (i) and (ii) on the path rule (iv) guarantees a delegated account lands in.
 *
 * `clearRuntimeCredentialsForDelegatedAccount` takes the delegated account OUT of the desktop's
 * active selection, which puts it squarely in `fetchInactiveClaudeAccountsOnOpen`'s list — so the
 * inactive-account usage poll is the ORDINARY state for a delegated account, not an edge case.
 * Two writers live on that path: the refresh+persist arm, and the usage-panel `claude` launch.
 */

const { netFetchMock, readFileMock, appGetPathMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  readFileMock: vi.fn(),
  appGetPathMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  net: { fetch: netFetchMock },
  session: {
    defaultSession: {
      resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
      setProxy: vi.fn()
    }
  }
}))

vi.mock('./claude-pty', () => ({ fetchViaPty: vi.fn() }))

vi.mock('../claude-accounts/oauth-refresh', () => ({
  isOauthTokenExpiring: vi.fn(),
  refreshClaudeOauthCredentials: vi.fn()
}))

vi.mock('../claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn().mockResolvedValue(null),
  readActiveClaudeKeychainCredentialsStrict: vi.fn().mockResolvedValue(null),
  readManagedClaudeKeychainCredentials: vi.fn().mockResolvedValue(null),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const ACCOUNT_ID = 'account-delegated'
const LANE_PRINCIPAL = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

let leaseRows: ClaudeLaneDelegationLease[] = []

function delegate(accountId: string): void {
  const store = new LaneDelegationLeaseStore({
    persistence: {
      getClaudeLaneDelegationLeases: () => leaseRows,
      setClaudeLaneDelegationLeases: (next) => {
        leaseRows = [...next]
      }
    }
  })
  store.take({
    accountId,
    accountUuid: null,
    hostId: 'host-1',
    principalId: LANE_PRINCIPAL,
    delegatedGrantId: 'desktop-a'
  })
  attachLaneDelegationLeaseStore(store)
}

describe('inactive-account usage poll under a lane delegation (§2e i and ii)', () => {
  let tempDir: string | null = null
  let ownedAuthPath = ''

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    leaseRows = []
    attachLaneDelegationLeaseStore(null)
    vi.clearAllMocks()
    readFileMock.mockRejectedValue(new Error('missing file'))
    tempDir = mkdtempSync(join(tmpdir(), 'orca-delegated-usage-'))
    appGetPathMock.mockReturnValue(tempDir)
    ownedAuthPath = join(tempDir, 'claude-accounts', ACCOUNT_ID, 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), `${ACCOUNT_ID}\n`, 'utf-8')
    writeFileSync(
      join(ownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'lane-held-token', expiresAt: Date.now() + 60_000 }
      }),
      'utf-8'
    )
    netFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }),
        { status: 200 }
      )
    )
    vi.mocked(isOauthTokenExpiring).mockReturnValue(true)
    vi.mocked(refreshClaudeOauthCredentials).mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'rotated-token', expiresAt: Date.now() + 3_600_000 }
      })
    )
    vi.mocked(fetchViaPty).mockResolvedValue({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    })
  })

  afterEach(() => {
    attachLaneDelegationLeaseStore(null)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not rotate the single-use refresh token of a delegated account', async () => {
    delegate(ACCOUNT_ID)

    await fetchManagedAccountUsage({ id: ACCOUNT_ID, managedAuthPath: ownedAuthPath })

    expect(refreshClaudeOauthCredentials).not.toHaveBeenCalled()
  })

  // Negative control: the SAME poll on a non-delegated account still rotates, so the guard is not
  // passing merely because nothing on this path ever rotates.
  it('still rotates an expiring token when no delegation is published for the account', async () => {
    delegate('some-other-account')

    await fetchManagedAccountUsage({ id: ACCOUNT_ID, managedAuthPath: ownedAuthPath })

    expect(refreshClaudeOauthCredentials).toHaveBeenCalledTimes(1)
  })

  it('does not launch a managed `claude` under a delegated account for the usage panel', async () => {
    delegate(ACCOUNT_ID)

    await fetchManagedAccountUsage(
      { id: ACCOUNT_ID, managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  // Negative control for the launch gate.
  it('still launches the usage-panel supplement for a non-delegated account', async () => {
    delegate('some-other-account')

    await fetchManagedAccountUsage(
      { id: ACCOUNT_ID, managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(fetchViaPty).toHaveBeenCalledTimes(1)
  })
})
