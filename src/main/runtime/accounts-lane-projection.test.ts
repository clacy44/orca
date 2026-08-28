import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
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
  const coordinator = new LaneCredentialCoordinator({
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
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  attachLaneWireService(service)
  return { service, lanesRoot, userData }
}

/** Loads a lane's own credential file directly — the lane's CLI is the only writer now (§2e). */
function loadLane(lanesRoot: string, laneId: string, refreshToken: string): void {
  writeFileSync(join(lanesRoot, laneId, '.credentials.json'), credentials(refreshToken))
  writeFileSync(
    join(lanesRoot, laneId, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: 'acct-lane', emailAddress: 'ana@corp.test' } })
  )
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

  it('shows a peer lane as occupied plus a label, and never an email or identity', () => {
    const harness = attachService()
    loadLane(harness.lanesRoot, LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, 'device-b') as {
      claudeLanes: Record<string, unknown>[]
    }
    const peerRow = projected.claudeLanes.find((row) => row.scope === 'peer')
    // §2d's peer enumeration is closed, and `laneState` is not on it: `reauth-required` would
    // tell a peer the other person's account is in a broken-auth state.
    expect(peerRow).toEqual({ scope: 'peer', occupied: true, ownerLabel: 'Ana' })
    expect(JSON.stringify(projected)).not.toContain('ana@corp.test')
    expect(JSON.stringify(projected)).not.toContain('acct-lane')
  })

  it('shows the caller own lane with its identity and designation', () => {
    const harness = attachService()
    loadLane(harness.lanesRoot, LANE_A, 'rt-1')
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
  })

  it('gives an anonymous local caller no self row at all', () => {
    const harness = attachService()
    loadLane(harness.lanesRoot, LANE_A, 'rt-1')
    const projected = projectAccountsSnapshot(SNAPSHOT, undefined) as {
      claudeLanes: Record<string, unknown>[]
    }
    expect(projected.claudeLanes.every((row) => row.scope === 'peer')).toBe(true)
  })

  // The self row and the caller-scope refusal must read "does this caller hold a lane" from ONE
  // source. When they disagreed, the phone read `holdsLane: false`, sent `accounts.selectClaude`,
  // and was refused out of scope with no delegated route — §2l's "never degrades", broken.
  it('still shows the caller own lane when the peer enumerator is absent', () => {
    const harness = attachService({ listPrincipals: false })
    loadLane(harness.lanesRoot, LANE_A, 'rt-1')
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

  it('keeps the host account rows untouched beside the lane rows', () => {
    const harness = attachService()
    loadLane(harness.lanesRoot, LANE_A, 'rt-1')
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
