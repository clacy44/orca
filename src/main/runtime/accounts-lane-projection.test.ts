import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeLaneDelegationRow } from '../../shared/claude-lane-delegation'
import type { ClaudeLaneCredentialWatermark } from '../../shared/claude-lane-watermark'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import {
  ManagedAccountResidencyGuard,
  assertManagedClaudeAccountNotLaneResident
} from '../claude-accounts/managed-account-lane-residency'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { assertClaudeSelectionInScope, projectAccountsSnapshot } from './accounts-lane-projection'
import { attachLaneWireService, LaneWireService } from './lane-wire-service'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'
const SNAPSHOT = {
  claude: { accounts: [{ id: 'acct-1', email: 'host@example.com' }], activeAccountId: 'acct-1' },
  codex: { accounts: [] },
  rateLimits: {}
}

const createdDirs: string[] = []

afterEach(() => {
  attachLaneWireService(null)
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function credentials(refreshToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${refreshToken}`,
      refreshToken,
      expiresAt: Date.now() + 3_600_000
    }
  })
}

function attachService(
  options: {
    provision?: string[]
    managedAccounts?: ClaudeManagedAccount[]
    /** The optional enumerator §2d's PEER rows use; the self row must not depend on it. */
    listPrincipals?: false
  } = {}
) {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-projection-'))
  createdDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  for (const laneId of options.provision ?? [LANE_A, LANE_B]) {
    provisionPrincipalLane(laneId, { lanesRoot, platform: 'linux' })
  }
  let watermarks: ClaudeLaneCredentialWatermark[] = []
  let delegationRows: ClaudeLaneDelegationRow[] = []
  const persistence = {
    getClaudeLaneCredentialWatermarks: () => watermarks,
    setClaudeLaneCredentialWatermarks: (rows: readonly ClaudeLaneCredentialWatermark[]) => {
      watermarks = [...rows]
    },
    getClaudeLaneDelegationRows: () => delegationRows,
    setClaudeLaneDelegationRows: (rows: readonly ClaudeLaneDelegationRow[]) => {
      delegationRows = [...rows]
    }
  }
  const coordinator = new LaneCredentialCoordinator({
    persistence,
    sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
    laneOptions: { lanesRoot, platform: 'linux' }
  })
  const bindings = new Map<string, string>([
    ['device-a', LANE_A],
    ['device-b', LANE_B]
  ])
  const labels = new Map<string, string>([
    [LANE_A, 'Ana'],
    [LANE_B, 'Ben']
  ])
  const service = new LaneWireService({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => (principalId === LANE_A ? 'device-a' : 'device-b'),
      labelOf: (principalId) => labels.get(principalId) ?? null,
      ...(options.listPrincipals === false
        ? {}
        : {
            listPrincipals: () =>
              (options.provision ?? [LANE_A, LANE_B]).map((principalId) => ({
                principalId,
                label: labels.get(principalId) ?? null
              }))
          })
    },
    coordinator,
    persistence,
    accounts: {
      findAccount: (accountId) =>
        options.managedAccounts?.find((account) => account.id === accountId) ?? null
    },
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  attachLaneWireService(service)
  return { service, lanesRoot, userData }
}

function pushInto(
  service: LaneWireService,
  deviceId: string,
  laneId: string,
  refreshToken: string
): Promise<unknown> {
  return service.authority.push(deviceId, {
    envelope: {
      credentialsJson: credentials(refreshToken),
      oauthAccountJson: JSON.stringify({ accountUuid: 'acct-lane', emailAddress: 'ana@corp.test' }),
      displayName: 'Ana work'
    },
    basedOnRefreshTokenSha256: null,
    delegation: { hostId: 'h', principalId: laneId, delegatedGrantId: deviceId, since: 1 }
  })
}

function refusalCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('accounts snapshot projection', () => {
  it('returns the very same object when the host has no lanes at all', () => {
    expect(projectAccountsSnapshot(SNAPSHOT, 'device-a')).toBe(SNAPSHOT)
    attachService({ provision: [] })
    expect(projectAccountsSnapshot(SNAPSHOT, 'device-a')).toBe(SNAPSHOT)
  })

  it('shows a peer lane as occupied plus a label and name, and never an email or identity', async () => {
    const harness = attachService()
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, 'device-b') as {
      claudeLanes: Record<string, unknown>[]
    }
    const peerRow = projected.claudeLanes.find((row) => row.scope === 'peer')
    // §2d's peer enumeration is closed, and `laneState` is not on it: `reauth-required` would
    // tell a peer the other person's account is in a broken-auth state.
    expect(peerRow).toEqual({
      scope: 'peer',
      occupied: true,
      ownerLabel: 'Ana',
      displayName: 'Ana work'
    })
    expect(JSON.stringify(projected)).not.toContain('ana@corp.test')
    expect(JSON.stringify(projected)).not.toContain('acct-lane')
  })

  it('shows the caller own lane with its identity, designation and delegable list', async () => {
    const harness = attachService()
    harness.service.delegation.setDelegableAccounts(LANE_A, [{ clientRef: 'ref-1' }])
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, 'device-a') as {
      claudeLanes: Record<string, unknown>[]
    }
    const selfRow = projected.claudeLanes.find((row) => row.scope === 'self')
    expect(selfRow).toMatchObject({
      laneState: 'loaded',
      occupied: true,
      ownerLabel: 'Ana',
      delegatedGrantId: 'device-a',
      callerIsDelegatedGrant: true,
      identity: { accountUuid: 'acct-lane', email: 'ana@corp.test' }
    })
    expect(selfRow?.delegable as unknown[]).toHaveLength(1)
  })

  it('gives an anonymous local caller no self row at all', async () => {
    const harness = attachService()
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, undefined) as {
      claudeLanes: Record<string, unknown>[]
    }
    expect(projected.claudeLanes.every((row) => row.scope === 'peer')).toBe(true)
  })

  // The self row and the caller-scope refusal must read "does this caller hold a lane" from ONE
  // source. When they disagreed, the phone read `holdsLane: false`, sent `accounts.selectClaude`,
  // and was refused out of scope with no delegated route — §2l's "never degrades", broken.
  it('still shows the caller own lane when the peer enumerator is absent', async () => {
    const harness = attachService({ listPrincipals: false })
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, 'device-a') as {
      claudeLanes: Record<string, unknown>[]
    }
    expect(projected.claudeLanes).toHaveLength(1)
    expect(projected.claudeLanes[0]).toMatchObject({ scope: 'self', ownerLabel: 'Ana' })
    // The same answer the refusal gives, from the same source.
    expect(refusalCode(() => assertClaudeSelectionInScope('device-a'))).toBe(
      'accounts.selection_out_of_scope'
    )
  })

  // Negative control: no enumerator does not invent a lane for a grant that holds none.
  it('gives a grant with no provisioned lane no self row and no refusal', () => {
    attachService({ provision: [LANE_B], listPrincipals: false })
    expect(projectAccountsSnapshot(SNAPSHOT, 'device-a')).toBe(SNAPSHOT)
    expect(refusalCode(() => assertClaudeSelectionInScope('device-a'))).toBe('no_refusal')
  })

  it('keeps the host account rows untouched beside the lane rows', async () => {
    const harness = attachService()
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, 'device-b') as typeof SNAPSHOT
    expect(projected.claude).toEqual(SNAPSHOT.claude)
  })
})

describe('selectClaude caller scope', () => {
  it('is inert with no lanes and for a grant with no provisioned lane', () => {
    expect(refusalCode(() => assertClaudeSelectionInScope('device-a'))).toBe('no_refusal')
    attachService({ provision: [LANE_B] })
    expect(refusalCode(() => assertClaudeSelectionInScope('device-a'))).toBe('no_refusal')
  })

  it('refuses a caller that holds a lane, and never an anonymous local caller', () => {
    attachService()
    expect(refusalCode(() => assertClaudeSelectionInScope('device-a'))).toBe(
      'accounts.selection_out_of_scope'
    )
    expect(refusalCode(() => assertClaudeSelectionInScope(undefined))).toBe('no_refusal')
    expect(refusalCode(() => assertClaudeSelectionInScope('device-unbound'))).toBe('no_refusal')
  })
})

describe('managed account residency guard', () => {
  const account: ClaudeManagedAccount = {
    id: 'acct-1',
    email: 'ana@corp.test',
    managedAuthPath: '/nonexistent/auth',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }

  it('is inert on a host with no lane wire attached', () => {
    expect(refusalCode(() => assertManagedClaudeAccountNotLaneResident('acct-1'))).toBe(
      'no_refusal'
    )
  })

  it('refuses a lane-resident account for every caller class, and passes an unrelated one', async () => {
    const harness = attachService({ managedAccounts: [account] })
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    // The guard resolves the account's own keys; here they are injected to stand for the files.
    const guard = harness.service.residencyGuard
    expect(guard).not.toBeNull()
    expect(
      refusalCode(() =>
        harness.service.coordinator.residency.assertNotLaneResident({
          accountId: 'acct-1',
          accountUuid: 'acct-lane',
          refreshTokenSha256: null
        })
      )
    ).toBe('accounts.lane.account_resident_elsewhere')
    expect(
      refusalCode(() =>
        harness.service.coordinator.residency.assertNotLaneResident({
          accountId: 'acct-2',
          accountUuid: 'acct-other',
          refreshTokenSha256: null
        })
      )
    ).toBe('no_refusal')
  })

  // The edge fails open when the account's own auth files cannot be read — §2d states the refusal
  // with no exemption, so the gap is at least observable rather than silent.
  it('reports rather than silently passing an account whose managed store it cannot read', async () => {
    const harness = attachService({ managedAccounts: [account] })
    await pushInto(harness.service, 'device-a', LANE_A, 'rt-1')
    const reported: { accountId: string; reason: string }[] = []
    const guard = new ManagedAccountResidencyGuard({
      residency: harness.service.coordinator.residency,
      accounts: { findAccount: () => account },
      resolveManagedAuthPath: (_accountId, candidatePath) => candidatePath,
      readManagedAuthFile: () => null,
      onResidencyUnverifiable: (accountId, reason) => reported.push({ accountId, reason })
    })
    expect(refusalCode(() => guard.assertNotLaneResident('acct-1'))).toBe('no_refusal')
    expect(reported).toEqual([{ accountId: 'acct-1', reason: 'auth-files-unreadable' }])
  })

  it('reports an unresolvable managed auth path, and stays silent for an unmanaged account', () => {
    const harness = attachService({ managedAccounts: [account] })
    const reported: string[] = []
    const guard = new ManagedAccountResidencyGuard({
      residency: harness.service.coordinator.residency,
      accounts: { findAccount: (accountId) => (accountId === 'acct-1' ? account : null) },
      resolveManagedAuthPath: () => null,
      onResidencyUnverifiable: (_accountId, reason) => reported.push(reason)
    })
    guard.assertNotLaneResident('acct-1')
    // Negative control: an account Orca does not manage is out of scope, not an unverified one.
    guard.assertNotLaneResident('acct-unmanaged')
    expect(reported).toEqual(['auth-path-unresolved'])
  })

  it('arms and disarms with the lane wire, so both edges move together', () => {
    const harness = attachService({ managedAccounts: [account] })
    expect(harness.service.residencyGuard).not.toBeNull()
    attachLaneWireService(null)
    expect(refusalCode(() => assertManagedClaudeAccountNotLaneResident('acct-1'))).toBe(
      'no_refusal'
    )
  })
})
