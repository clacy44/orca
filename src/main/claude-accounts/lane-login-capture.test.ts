import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readLaneAccountIndex } from './lane-account-index'
import { markLaneWipePending, resetLaneWipePendingForTests } from './lane-wipe-pending'

const spawnMocks = vi.hoisted(() => ({ spawnClaudeCliChildProcess: vi.fn() }))
vi.mock('./claude-cli-child-process', () => ({
  spawnClaudeCliChildProcess: spawnMocks.spawnClaudeCliChildProcess
}))

import { captureLaneLogin, type LaneLoginCaptureContext } from './lane-login-capture'
import type { LaneAuthState } from './lane-auth-state'
import type { LaneCredentialWriter } from './lane-credential-writer'

const LANE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

/** Scripts the `auth status --json` probe's raw stdout, or a spawn error when `null`. */
function scriptAuthStatus(json: string | null): void {
  spawnMocks.spawnClaudeCliChildProcess.mockImplementation(
    (_args, _configDir, _timeoutMs, options) => {
      if (json === null) {
        return {
          handle: { writeStdin: vi.fn(), kill: vi.fn() },
          result: Promise.reject(new Error('boom'))
        }
      }
      options?.onStdoutChunk?.(json)
      return {
        handle: { writeStdin: vi.fn(), kill: vi.fn() },
        result: Promise.resolve({ code: 0 })
      }
    }
  )
}

describe('captureLaneLogin (S9-L1 A4)', () => {
  let laneDir = ''
  let authDir = ''
  let writer: Pick<LaneCredentialWriter, 'writeCredentials' | 'writeOauthAccount'> & {
    writeCredentials: ReturnType<typeof vi.fn>
    writeOauthAccount: ReturnType<typeof vi.fn>
  }
  let queueEntries: string[]
  let authState: Pick<LaneAuthState, 'serializeLaneWrite'>
  let ctx: LaneLoginCaptureContext

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-capture-'))
    authDir = join(laneDir, 'claude-accounts', LANE_ACCOUNT_ID, 'auth')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(
      join(authDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } }),
      { mode: 0o600 }
    )
    writeFileSync(
      join(authDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', emailAddress: 'a@x.com' } }),
      { mode: 0o600 }
    )
    writer = {
      writeCredentials: vi.fn(async (_laneDir: string, _credentialsJson: string) => {}),
      writeOauthAccount: vi.fn((_laneDir: string, _oauthAccount: unknown) => true)
    }
    queueEntries = []
    authState = {
      serializeLaneWrite: async <T>(laneId: string, run: () => Promise<T>): Promise<T> => {
        queueEntries.push(`enter:${laneId}`)
        try {
          return await run()
        } finally {
          queueEntries.push(`exit:${laneId}`)
        }
      }
    }
    ctx = {
      laneId: 'lane-1',
      laneDir,
      laneAccountId: LANE_ACCOUNT_ID,
      authDir,
      expectedEmail: 'a@x.com',
      authState,
      writer,
      invalidateProbes: vi.fn(async (_laneId: string) => {}),
      isStillCapturable: () => true,
      onCaptured: vi.fn()
    }
    resetLaneWipePendingForTests()
    spawnMocks.spawnClaudeCliChildProcess.mockReset()
  })

  afterEach(() => {
    resetLaneWipePendingForTests()
    rmSync(laneDir, { recursive: true, force: true })
  })

  it('promotes the credential and writes the index row once identity matches (I6 pass)', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))

    const result = await captureLaneLogin(ctx)

    expect(result).toEqual({ kind: 'captured', email: 'a@x.com' })
    expect(writer.writeCredentials).toHaveBeenCalledWith(
      laneDir,
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
    )
    expect(writer.writeOauthAccount).toHaveBeenCalledWith(laneDir, {
      accountUuid: 'acct-1',
      emailAddress: 'a@x.com'
    })
    expect(ctx.onCaptured).toHaveBeenCalledTimes(1)
    const rows = readLaneAccountIndex(join(laneDir, 'claude-accounts'))
    expect(rows).toEqual([
      expect.objectContaining({ laneAccountId: LANE_ACCOUNT_ID, email: 'a@x.com', active: true })
    ])
    // I6's own artifact: the auth dir's own oauth-account.json is populated too.
    expect(JSON.parse(readFileSync(join(authDir, 'oauth-account.json'), 'utf-8'))).toEqual({
      accountUuid: 'acct-1',
      emailAddress: 'a@x.com'
    })
  })

  it("invalidates this lane's usage probes BEFORE rewriting the credential, so a probe still holding the old refresh token cannot rotate it back over the switch", async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))
    const order: string[] = []
    ;(ctx.invalidateProbes as ReturnType<typeof vi.fn>).mockImplementation(
      async (laneId: string) => {
        order.push(`invalidate:${laneId}`)
      }
    )
    writer.writeCredentials.mockImplementation(async () => {
      order.push('writeCredentials')
    })

    await captureLaneLogin(ctx)

    expect(ctx.invalidateProbes).toHaveBeenCalledWith('lane-1')
    expect(order).toEqual(['invalidate:lane-1', 'writeCredentials'])
  })

  it('marks a prior active row inactive when a second login is captured', async () => {
    writeFileSync(
      join(laneDir, 'claude-accounts', 'index.json'),
      JSON.stringify([
        {
          laneAccountId: '22222222-2222-4222-8222-222222222222',
          email: 'old@x.com',
          label: null,
          active: true,
          capturedAt: '2026-01-01T00:00:00.000Z'
        }
      ])
    )
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))

    await captureLaneLogin(ctx)

    const rows = readLaneAccountIndex(join(laneDir, 'claude-accounts'))
    expect(
      rows.find((row) => row.laneAccountId === '22222222-2222-4222-8222-222222222222')?.active
    ).toBe(false)
    expect(rows.find((row) => row.laneAccountId === LANE_ACCOUNT_ID)?.active).toBe(true)
  })

  it('I6 mismatch: sweeps the directory, never writes, never falls back to oauth-account.json', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'wrong@x.com' }))

    const result = await captureLaneLogin(ctx)

    expect(result).toEqual({ kind: 'identity_mismatch' })
    expect(writer.writeCredentials).not.toHaveBeenCalled()
    expect(writer.writeOauthAccount).not.toHaveBeenCalled()
    expect(ctx.onCaptured).not.toHaveBeenCalled()
    expect(existsSync(join(laneDir, 'claude-accounts', LANE_ACCOUNT_ID))).toBe(false)
    expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
  })

  // MP-c (plan §tests I6): the same mutation as the mismatch case, on the "unverifiable" input —
  // `auth status --json` reporting no identity at all must NOT fall back to the oauthAccount
  // block `.claude.json` already carries for the RIGHT email.
  it('I6 unverifiable: no identity in `auth status --json` output is a mismatch, not a pass', async () => {
    scriptAuthStatus(JSON.stringify({}))

    const result = await captureLaneLogin(ctx)

    expect(result).toEqual({ kind: 'identity_mismatch' })
    expect(writer.writeCredentials).not.toHaveBeenCalled()
  })

  it('I6 unverifiable: unparseable `auth status --json` output is a mismatch, not a pass', async () => {
    scriptAuthStatus('not json')

    const result = await captureLaneLogin(ctx)

    expect(result).toEqual({ kind: 'identity_mismatch' })
  })

  it('I6 unverifiable: a failed/timed-out probe reads as no identity, never a crash', async () => {
    scriptAuthStatus(null)

    await expect(captureLaneLogin(ctx)).resolves.toEqual({ kind: 'identity_mismatch' })
  })

  it('treats a matched email with no credentials file as unverifiable too', async () => {
    rmSync(join(authDir, '.credentials.json'))
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))

    const result = await captureLaneLogin(ctx)

    expect(result).toEqual({ kind: 'identity_mismatch' })
    expect(writer.writeCredentials).not.toHaveBeenCalled()
  })

  it('in-turn re-check: refuses login_cancelled when the session is no longer capturable', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))
    ctx.isStillCapturable = () => false

    await expect(captureLaneLogin(ctx)).rejects.toMatchObject({
      code: 'accounts.lane.login_cancelled'
    })
    expect(writer.writeCredentials).not.toHaveBeenCalled()
    expect(ctx.onCaptured).not.toHaveBeenCalled()
    // I6 already passed outside the queue, so the row simply never gets written — the directory
    // itself is cancel's own sweep, not this module's.
    expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
  })

  it('in-turn re-check is done INSIDE the write queue turn, not before it', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))
    let checkedInsideQueue = false
    ctx.isStillCapturable = () => {
      checkedInsideQueue =
        queueEntries.includes('enter:lane-1') && !queueEntries.includes('exit:lane-1')
      return true
    }

    await captureLaneLogin(ctx)

    expect(checkedInsideQueue).toBe(true)
  })

  it('wipe-pending is a SECOND, advisory refusal — session state is the correctness check', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))
    markLaneWipePending('lane-1')

    await expect(captureLaneLogin(ctx)).rejects.toMatchObject({
      code: 'accounts.lane.wipe_in_progress'
    })
    expect(writer.writeCredentials).not.toHaveBeenCalled()
  })

  it('every thrown refusal is a typed ClaudeLaneRefusal', async () => {
    scriptAuthStatus(JSON.stringify({ email: 'a@x.com' }))
    ctx.isStillCapturable = () => false

    try {
      await captureLaneLogin(ctx)
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
    }
  })
})
