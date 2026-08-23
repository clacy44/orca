import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneDelegationLease } from '../../shared/claude-lane-lease'
import {
  LaneDelegationLeaseStore,
  assertClaudeAccountNotDelegatedToLane,
  attachLaneDelegationLeaseStore,
  isClaudeAccountDelegatedToLane
} from './lane-delegation-lease'
import { clearRuntimeCredentialsForDelegatedAccount } from './runtime-credential-lane-clearing'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const createdDirs: string[] = []

afterEach(() => {
  attachLaneDelegationLeaseStore(null)
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeStore(options: { now?: () => number; ttlMs?: number } = {}) {
  let rows: ClaudeLaneDelegationLease[] = []
  const cleared: ClaudeLaneDelegationLease[] = []
  const store = new LaneDelegationLeaseStore({
    persistence: {
      getClaudeLaneDelegationLeases: () => rows,
      setClaudeLaneDelegationLeases: (next) => {
        rows = [...next]
      }
    },
    now: options.now,
    ttlMs: options.ttlMs,
    clearRuntimeCredentials: (lease) => cleared.push(lease)
  })
  return { store, cleared, peek: () => rows }
}

const status = (overrides: Partial<ClaudeLaneStatus> = {}): ClaudeLaneStatus => ({
  laneId: LANE_A,
  laneState: 'loaded',
  delegatedGrantId: 'desktop-a',
  callerIsDelegatedGrant: true,
  heldDisplayName: 'Work',
  heldIdentity: { accountUuid: 'acct-uuid-1', email: 'ana@corp.test', organizationUuid: null },
  refreshTokenSha256: null,
  expiresAt: null,
  delegable: [],
  ...overrides
})

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('desktop delegation lease', () => {
  it('suppresses the rotator for the account whether or not this desktop holds the lease', () => {
    const holder = makeStore()
    holder.store.take({
      accountId: 'acct-1',
      accountUuid: 'acct-uuid-1',
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    const other = makeStore()
    other.store.take({
      accountId: 'acct-1',
      accountUuid: 'acct-uuid-1',
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    expect(holder.store.isDelegated('acct-1')).toBe(true)
    expect(other.store.isDelegated('acct-1')).toBe(true)
    expect(holder.store.isDelegated('acct-2')).toBe(false)
  })

  it('survives a simulated restart because it lives in the store, not in the process', () => {
    const rows: ClaudeLaneDelegationLease[] = []
    const persistence = {
      getClaudeLaneDelegationLeases: () => rows,
      setClaudeLaneDelegationLeases: (next: readonly ClaudeLaneDelegationLease[]) => {
        rows.splice(0, rows.length, ...next)
      }
    }
    new LaneDelegationLeaseStore({ persistence }).take({
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    const afterRestart = new LaneDelegationLeaseStore({ persistence })
    expect(afterRestart.isDelegated('acct-1')).toBe(true)
  })

  it('is released by a cleared designation, never by a disconnect', () => {
    const harness = makeStore()
    harness.store.applyPublishedStatus('host-1', status(), () => 'acct-1')
    expect(harness.store.isDelegated('acct-1')).toBe(true)
    // A status that simply stops being published changes nothing: no call, no release.
    expect(harness.store.isDelegated('acct-1')).toBe(true)
    harness.store.applyPublishedStatus(
      'host-1',
      status({ delegatedGrantId: null, laneState: 'absent', heldIdentity: null }),
      () => null
    )
    expect(harness.store.isDelegated('acct-1')).toBe(false)
  })

  it('keeps the lease when the published identity is one this desktop cannot resolve', () => {
    const harness = makeStore()
    harness.store.applyPublishedStatus('host-1', status(), () => 'acct-1')
    // A lane briefly absent, or holding an account added on another machine, must NOT un-suppress:
    // release is a cleared designation, a clear or expiry — never an unrecognised publish.
    harness.store.applyPublishedStatus('host-1', status({ laneState: 'absent' }), () => null)
    expect(harness.store.isDelegated('acct-1')).toBe(true)
  })

  it('releases the previous account when the lane moves to another one', () => {
    const harness = makeStore()
    harness.store.applyPublishedStatus('host-1', status(), () => 'acct-1')
    harness.store.applyPublishedStatus(
      'host-1',
      status({ heldIdentity: { accountUuid: 'acct-uuid-2', email: null, organizationUuid: null } }),
      () => 'acct-2'
    )
    expect(harness.store.isDelegated('acct-1')).toBe(false)
    expect(harness.store.isDelegated('acct-2')).toBe(true)
  })

  it('expires rather than suppressing forever against a host that never comes back', () => {
    let now = 1_000
    const harness = makeStore({ now: () => now, ttlMs: 500 })
    harness.store.take({
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    expect(harness.store.isDelegated('acct-1')).toBe(true)
    now += 501
    expect(harness.store.isDelegated('acct-1')).toBe(false)
  })

  it('keeps `since` across a renewal so the lease reports when it actually began', () => {
    let now = 1_000
    const harness = makeStore({ now: () => now })
    const first = harness.store.take({
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    now += 5_000
    const renewed = harness.store.take({
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    expect(renewed.since).toBe(first.since)
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt ?? 0)
  })

  it('refuses a local selection and a local managed launch of a delegated account', () => {
    const harness = makeStore()
    harness.store.take({
      accountId: 'acct-1',
      accountUuid: null,
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    attachLaneDelegationLeaseStore(harness.store)
    expect(refusalCode(() => assertClaudeAccountNotDelegatedToLane('acct-1'))).toBe(
      'accounts.lane.delegated_elsewhere'
    )
    expect(refusalCode(() => harness.store.assertLaunchAllowed('acct-1'))).toBe(
      'accounts.lane.delegated_elsewhere'
    )
    expect(refusalCode(() => assertClaudeAccountNotDelegatedToLane('acct-2'))).toBe('no_refusal')
  })

  it('is inert with no lease store attached', () => {
    expect(isClaudeAccountDelegatedToLane('acct-1')).toBe(false)
    expect(refusalCode(() => assertClaudeAccountNotDelegatedToLane('acct-1'))).toBe('no_refusal')
  })

  it('clears the runtime credential file as part of taking the lease', () => {
    const harness = makeStore()
    harness.store.take({
      accountId: 'acct-1',
      accountUuid: 'acct-uuid-1',
      hostId: 'host-1',
      principalId: LANE_A,
      delegatedGrantId: 'desktop-a'
    })
    expect(harness.cleared).toHaveLength(1)
  })
})

describe('rule (iv) runtime credential clearing', () => {
  function makeRuntimeDir(): { credentialsPath: string; configPath: string; configDir: string } {
    const configDir = mkdtempSync(join(tmpdir(), 'orca-runtime-claude-'))
    createdDirs.push(configDir)
    return {
      configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      configPath: join(configDir, '.claude.json')
    }
  }

  const delegated = { accountUuid: 'acct-uuid-1', email: 'ana@corp.test', organizationUuid: null }

  it('clears the credential and the oauthAccount key when the file holds that account', () => {
    const paths = makeRuntimeDir()
    writeFileSync(
      paths.credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', accountUuid: 'acct-uuid-1' } })
    )
    writeFileSync(
      paths.configPath,
      JSON.stringify({ oauthAccount: { accountUuid: 'acct-uuid-1' }, other: 1 })
    )
    const result = clearRuntimeCredentialsForDelegatedAccount(paths, delegated, {
      platform: 'linux'
    })
    expect(result).toEqual({ cleared: true, reason: 'cleared' })
    expect(JSON.parse(readFileSync(paths.configPath, 'utf-8'))).toEqual({ other: 1 })
  })

  // Negative control: an unrelated login on this machine is not the lease's business.
  it('leaves a known different account alone', () => {
    const paths = makeRuntimeDir()
    writeFileSync(
      paths.credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', accountUuid: 'acct-uuid-9' } })
    )
    const result = clearRuntimeCredentialsForDelegatedAccount(paths, delegated, {
      platform: 'linux'
    })
    expect(result.reason).toBe('different-account')
    expect(readFileSync(paths.credentialsPath, 'utf-8')).toContain('acct-uuid-9')
  })

  it('reports absent when there is nothing to clear', () => {
    expect(
      clearRuntimeCredentialsForDelegatedAccount(makeRuntimeDir(), delegated, {
        platform: 'linux'
      })
    ).toEqual({ cleared: false, reason: 'absent' })
  })

  it('deletes the scoped keychain item on darwin before the file', () => {
    const paths = makeRuntimeDir()
    writeFileSync(paths.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'at' } }))
    const deleteKeychainItem = vi.fn()
    clearRuntimeCredentialsForDelegatedAccount(paths, delegated, {
      platform: 'darwin',
      deleteKeychainItem
    })
    expect(deleteKeychainItem).toHaveBeenCalledWith(paths.configDir)
  })
})
