import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { AccountResidencyIndex } from './account-residency-index'
import {
  ManagedAccountResidencyGuard,
  attachManagedAccountResidencyGuard
} from './managed-account-lane-residency'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'orca-claude-lane-residency-test') }
}))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const ACCOUNT: ClaudeManagedAccount = {
  id: 'acct-1',
  email: 'ana@corp.test',
  managedAuthPath: '/managed/acct-1/auth',
  authMethod: 'subscription-oauth',
  createdAt: 0,
  updatedAt: 0,
  lastAuthenticatedAt: 0
}

afterEach(() => {
  attachManagedAccountResidencyGuard(null)
})

function armGuard(): AccountResidencyIndex {
  const residency = new AccountResidencyIndex({
    sharedLane: { readCredentials: () => null, readOauthAccount: () => null },
    resolvePresenceLabel: () => 'Ana'
  })
  residency.setLaneRow(
    LANE_A,
    JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt-1' } }),
    { accountUuid: 'acct-uuid-1' }
  )
  attachManagedAccountResidencyGuard(
    new ManagedAccountResidencyGuard({
      residency,
      accounts: { findAccount: (id) => (id === ACCOUNT.id ? ACCOUNT : null) },
      resolveManagedAuthPath: (_accountId, candidatePath) => candidatePath,
      // Stands in for the account's own Orca-owned auth directory.
      readManagedAuthFile: (_path, fileName) =>
        fileName === 'oauth-account.json' ? JSON.stringify({ accountUuid: 'acct-uuid-1' }) : null
    })
  )
  return residency
}

async function service() {
  const { ClaudeAccountService } = await import('./service')
  const store = {
    getSettings: () => ({ claudeManagedAccounts: [ACCOUNT], activeClaudeManagedAccountId: null })
  }
  return new ClaudeAccountService(store as never, {} as never, {} as never)
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${(error as Error).message}`
  }
  return 'no_refusal'
}

describe('L1 second edge on the managed account funnels', () => {
  it('refuses selectClaude of a lane-resident account, whatever the caller class', async () => {
    armGuard()
    const accounts = await service()
    expect(await refusalCode(() => accounts.selectAccount('acct-1'))).toBe(
      'accounts.lane.account_resident_elsewhere'
    )
  })

  it('refuses removeClaude of the same account', async () => {
    armGuard()
    const accounts = await service()
    expect(await refusalCode(() => accounts.removeAccount('acct-1'))).toBe(
      'accounts.lane.account_resident_elsewhere'
    )
  })

  // Negative control: the guard must not turn into a blanket refusal of every account.
  it('lets an unrelated account past the residency gate', async () => {
    armGuard()
    const accounts = await service()
    expect(await refusalCode(() => accounts.selectAccount('acct-other'))).not.toBe(
      'accounts.lane.account_resident_elsewhere'
    )
  })

  it('is inert with no guard attached, so a pre-lane host behaves exactly as today', async () => {
    const accounts = await service()
    expect(await refusalCode(() => accounts.selectAccount('acct-1'))).not.toBe(
      'accounts.lane.account_resident_elsewhere'
    )
  })

  it('names the holding principal label so the refusal carries its remedy', async () => {
    armGuard()
    const accounts = await service()
    try {
      await accounts.selectAccount('acct-1')
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect((error as Error).message).toContain('Ana')
    }
  })
})
