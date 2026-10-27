/* eslint-disable max-lines -- Why: Claude rate-limit fallback tests share account/keychain/PTY mocks that would be noisier split apart. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchViaPty } from './claude-pty'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const { netFetchMock, readFileMock, resolveProxyMock, setProxyMock, appGetPathMock } = vi.hoisted(
  () => ({
    netFetchMock: vi.fn(),
    readFileMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn(),
    appGetPathMock: vi.fn()
  })
)

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  },
  net: {
    fetch: netFetchMock
  },
  session: {
    defaultSession: {
      resolveProxy: resolveProxyMock,
      setProxy: setProxyMock
    }
  }
}))

vi.mock('./claude-pty', () => ({
  fetchViaPty: vi.fn()
}))

vi.mock('../claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

describe('fetchClaudeRateLimits', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    setPlatform('darwin')
    tempDir = null
    vi.clearAllMocks()
    readFileMock.mockRejectedValue(new Error('missing file'))
    vi.mocked(readActiveClaudeKeychainCredentials).mockResolvedValue(null)
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(null)
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValue(null)
    vi.mocked(writeActiveClaudeKeychainCredentials).mockResolvedValue()
    vi.mocked(deleteActiveClaudeKeychainCredentialsStrict).mockResolvedValue()
    vi.mocked(writeManagedClaudeKeychainCredentials).mockResolvedValue()
    appGetPathMock.mockReturnValue('/tmp/orca-claude-fetcher-test')
    resolveProxyMock.mockResolvedValue('DIRECT')
    netFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 }
        }),
        { status: 200 }
      )
    )
    vi.mocked(fetchViaPty).mockResolvedValue({
      provider: 'claude',
      session: { usedPercent: 56, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: 1,
      error: null,
      status: 'ok'
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not read host credentials when WSL config resolution fails', async () => {
    await expect(
      fetchClaudeRateLimits({
        authPreparation: {
          configDir: '/Users/test/.claude',
          runtime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxConfigDir: null,
          envPatch: {},
          stripAuthEnv: true,
          provenance: 'wsl:Ubuntu:system'
        }
      })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'WSL Claude config unavailable for Ubuntu'
    })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('reads scoped Keychain credentials when the Claude config dir is explicit', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(configDir)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
          'User-Agent': 'claude-code/2.1.0'
        })
      })
    )
  })

  it('falls back to the legacy keychain token when the scoped token is rejected as stale', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({
            claudeAiOauth: { accessToken: 'stale-scoped-token', refreshToken: 'refresh-1' }
          })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )
    netFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
      return auth === 'Bearer fresh-legacy-token'
        ? new Response(
            JSON.stringify({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }),
            { status: 200 }
          )
        : new Response(
            JSON.stringify({ error: { message: 'Invalid authentication credentials' } }),
            { status: 401 }
          )
    })

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('prefers a legacy access token over scoped refresh-only credentials', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only' } })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 }
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fresh-legacy-token' })
      })
    )
  })

  it('does not retry with the legacy keychain for managed account credentials', async () => {
    const configDir = '/Users/test/managed-account'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: true,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir ? JSON.stringify({ claudeAiOauth: { accessToken: 'stale-managed-token' } }) : null
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalledWith(undefined)
  })

  it('does not retry with the legacy keychain for WSL targets', async () => {
    // Why: a WSL target's stale credentials must never be answered with the
    // host user's legacy macOS Keychain account.
    const configDir = '\\\\wsl$\\Ubuntu\\home\\test\\.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxConfigDir: '/home/test/.claude',
      envPatch: { CLAUDE_CONFIG_DIR: '/home/test/.claude' },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockImplementation(async (dir) =>
      dir
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'stale-wsl-token' } })
        : JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-legacy-token' } })
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).not.toHaveBeenCalledWith(undefined)
  })

  it('skips the legacy retry when the legacy item mirrors the failed scoped token', async () => {
    // Why: Claude's usage endpoint has a tight request budget; retrying the
    // identical token would double the request for a guaranteed second 401.
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'mirrored-token' } })
    )
    netFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }), {
        status: 401
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error'
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(undefined)
  })

  it('accepts Claude Code statusline-style rate limit window fields', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { used_percentage: 23.5, resets_at: 1770000000 },
          seven_day: { used_percentage: 41.2, resets_at: 1770604800 },
          fable_weekly: { used_percentage: 12.3, resets_at: 1770691200 }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 23.5, resetsAt: 1770000000000 },
      weekly: { usedPercent: 41.2, resetsAt: 1770604800000 },
      fableWeekly: { usedPercent: 12.3, resetsAt: 1770691200000 }
    })
  })

  it('maps active Fable usage from the scoped OAuth limits array without a PTY read', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 36 },
          seven_day: { utilization: 73 },
          fable_weekly: { utilization: 12 },
          limits: [
            { kind: 'weekly_scoped', percent: 55, scope: null },
            {
              kind: 'weekly_scoped',
              percent: 100,
              resets_at: '2026-07-17T20:00:00.099908+00:00',
              is_active: true,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowUsagePanelSupplement: true })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      fableWeekly: {
        usedPercent: 100,
        resetsAt: Date.parse('2026-07-17T20:00:00.099908+00:00')
      },
      usageMetadata: { attemptedSources: ['oauth'] }
    })
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('surfaces inactive scoped Fable usage over the legacy OAuth fallback', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          fable_weekly: { utilization: 33 },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 90,
              is_active: false,
              scope: { model: { display_name: 'fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      fableWeekly: { usedPercent: 90 }
    })
  })

  it('surfaces an inactive scoped Fable entry when no legacy Fable field exists (#8979)', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 64,
              resets_at: '2026-07-24T20:00:00+00:00',
              is_active: false,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      fableWeekly: {
        usedPercent: 64,
        resetsAt: Date.parse('2026-07-24T20:00:00+00:00')
      }
    })
  })

  it('supplements managed-account OAuth usage with Fable from the CLI usage panel', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { used_percentage: 23.5, resets_at: 1770000000 },
          seven_day: { used_percentage: 41.2, resets_at: 1770604800 }
        }),
        { status: 200 }
      )
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: { usedPercent: 91, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      fableWeekly: {
        usedPercent: 12.3,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d 2h'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 23.5, resetsAt: 1770000000000 },
      weekly: { usedPercent: 41.2, resetsAt: 1770604800000 },
      fableWeekly: { usedPercent: 12.3, resetDescription: '3d 2h' },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli']
      }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('supplements system OAuth usage when the service explicitly allows usage-panel reads', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '4d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(
      fetchClaudeRateLimits({
        authPreparation,
        allowPtyFallback: false,
        allowUsagePanelSupplement: true
      })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 },
      fableWeekly: { usedPercent: 58, resetDescription: '4d' },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli']
      }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('ignores bare Fable OAuth usage because the window length is ambiguous', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 11 },
          seven_day: { utilization: 22 },
          fable: { utilization: 33 }
        }),
        { status: 200 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 11 },
      weekly: { usedPercent: 22 },
      fableWeekly: null
    })
  })

  it('falls back to legacy Keychain credentials for host system default without an explicit config dir', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'host',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'legacy-oauth-token',
            expiresAt: Date.now() + 60_000
          }
        })
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(1, configDir)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2, undefined)
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-oauth-token'
        })
      })
    )
  })

  it('reads scoped Keychain credentials for host system default without an explicit config dir', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      runtime: 'host',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'scoped-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 }
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(configDir)
    expect(readActiveClaudeKeychainCredentials).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer scoped-oauth-token'
        })
      })
    )
  })

  it('falls back to the credentials file when Keychain access fails', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockRejectedValue(
      new Error('Keychain locked')
    )
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-oauth-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok'
    })

    expect(readFileMock).toHaveBeenCalledWith(
      join('/Users/test/.claude', '.credentials.json'),
      'utf-8'
    )
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer file-oauth-token'
        })
      })
    )
  })

  it('falls back to legacy Keychain when scoped credentials are unusable', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce('{not-json')
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'legacy-oauth-token',
            expiresAt: Date.now() + 60_000
          }
        })
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok'
    })

    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(1, configDir)
    expect(readActiveClaudeKeychainCredentialsStrict).toHaveBeenNthCalledWith(2, undefined)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-oauth-token'
        })
      })
    )
  })

  it('tries OAuth usage even when local credential metadata is expired', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 }
    })

    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer expired-oauth-token'
        })
      })
    )
    expect(readFileMock).not.toHaveBeenCalled()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not mask OAuth usage rate limits with the PTY fallback', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.'
          }
        }),
        { status: 429, headers: { 'retry-after': '3000' } }
      )
    )

    const before = Date.now()
    const result = await fetchClaudeRateLimits({ authPreparation })
    expect(result).toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude usage is rate limited right now.',
      usageMetadata: expect.objectContaining({ failureKind: 'rate-limited' })
    })
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3000 * 1000)
    expect(result.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 3000 * 1000)

    expect(netFetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer expired-oauth-token'
        })
      })
    )
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('omits retryAtMs when a 429 has no Retry-After header', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limited. Please try again later.'
          }
        }),
        { status: 429 }
      )
    )

    const result = await fetchClaudeRateLimits({ authPreparation })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.retryAtMs).toBeUndefined()
    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('uses CLI fallback for OAuth auth failures when automatic repair is safe', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stale-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Invalid OAuth token.'
          }
        }),
        { status: 401 }
      )
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['oauth', 'cli']
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('re-reads credentials and retries OAuth once after CLI repair', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'stale-oauth-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() - 60_000
          }
        })
      )
      // Legacy item absent — the stale-scoped legacy fallback must not preempt
      // CLI repair in this scenario.
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'repaired-oauth-token',
            refreshToken: 'refresh-token-2',
            expiresAt: Date.now() + 60_000
          }
        })
      )
    netFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: 'authentication_error',
              message: 'Invalid OAuth token.'
            }
          }),
          { status: 401 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 14 },
            seven_day: { utilization: 27 }
          }),
          { status: 200 }
        )
      )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 14 },
      weekly: { usedPercent: 27 },
      usageMetadata: {
        source: 'oauth',
        attemptedSources: ['oauth', 'cli'],
        credentialSource: 'scoped-keychain'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer repaired-oauth-token'
        })
      })
    )
  })

  it('explains auth failures when a live Claude terminal owns managed refresh', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      managedRefreshDeferredByLivePty: true,
      provenance: 'managed:account-1'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stale-oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Invalid OAuth token.'
          }
        }),
        { status: 401 }
      )
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start CLI fallback when live Claude owns managed refresh and no token is readable', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      managedRefreshDeferredByLivePty: true,
      provenance: 'managed:account-1'
    }

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error:
        'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.',
      usageMetadata: {
        failureKind: 'deferred-by-live-session',
        deferredByLiveClaudeSession: true,
        attemptedSources: []
      }
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start the PTY fallback when disabled for background fetches', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'oauth-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() + 60_000
        }
      })
    )
    netFetchMock.mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'OAuth API returned 500'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('does not start the PTY fallback for refresh-only credentials when disabled', async () => {
    const configDir = '/Users/test/.claude'
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir,
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 60_000
        }
      })
    )

    await expect(
      fetchClaudeRateLimits({ authPreparation, allowPtyFallback: false })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude OAuth access token unavailable'
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('falls back to CLI when OAuth credentials are missing in automatic mode', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('marks CLI plan usage shell results as usage unavailable', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'Claude plan usage is unavailable for this Claude CLI session.',
      status: 'error'
    })

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude plan usage is unavailable for this Claude CLI session.',
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        failureKind: 'usage-unavailable'
      }
    })
  })

  it('surfaces Keychain read failures as structured usage metadata when CLI fallback is disabled', async () => {
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValueOnce(
      new Error('security timed out after 3000ms')
    )

    await expect(fetchClaudeRateLimits({ allowPtyFallback: false })).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'Claude Keychain credentials unavailable',
      usageMetadata: {
        failureKind: 'keychain-unavailable',
        attemptedSources: [],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).not.toHaveBeenCalled()
  })

  it('uses CLI fallback when Keychain is unavailable in automatic mode', async () => {
    const authPreparation: ClaudeRuntimeAuthPreparation = {
      configDir: '/Users/test/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }
    vi.mocked(readActiveClaudeKeychainCredentials).mockRejectedValueOnce(
      new Error('security timed out after 3000ms')
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 56 },
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        credentialSource: 'none'
      }
    })

    expect(fetchViaPty).toHaveBeenCalledWith({ authPreparation })
  })

  it('does not read inactive managed credentials from unowned auth paths', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const unownedAuthPath = join(tempDir, 'unowned', 'auth')
    mkdirSync(unownedAuthPath, { recursive: true })
    writeFileSync(join(unownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    writeFileSync(
      join(unownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'unowned-token',
          expiresAt: Date.now() + 60_000
        }
      }),
      'utf-8'
    )

    await expect(
      fetchManagedAccountUsage({ id: 'account-1', managedAuthPath: unownedAuthPath })
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'error',
      error: 'No credentials'
    })

    expect(netFetchMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('supplements inactive managed account OAuth usage with Fable from its usage panel', async () => {
    setPlatform('linux')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const canonicalAuthPath = realpathSync(ownedAuthPath)
    writeFileSync(
      join(ownedAuthPath, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'inactive-token',
          expiresAt: Date.now() + 3_600_000
        }
      }),
      'utf-8'
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 42,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '2d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    await expect(
      fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: ownedAuthPath },
        { allowUsagePanelSupplement: true }
      )
    ).resolves.toMatchObject({
      provider: 'claude',
      status: 'ok',
      session: { usedPercent: 12 },
      weekly: { usedPercent: 34 },
      fableWeekly: { usedPercent: 42, resetDescription: '2d' }
    })
    expect(fetchViaPty).toHaveBeenCalledWith({
      authPreparation: expect.objectContaining({
        configDir: canonicalAuthPath,
        envPatch: { CLAUDE_CONFIG_DIR: canonicalAuthPath },
        provenance: 'managed:account-1:inactive-preview',
        stripAuthEnv: true
      })
    })
  })

  it('stages macOS inactive account credentials in a scoped Keychain for Fable preview', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const credentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'managed-keychain-token',
        expiresAt: Date.now() + 3_600_000
      }
    })
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const canonicalAuthPath = realpathSync(ownedAuthPath)
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(credentialsJson)
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 34,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(result.fableWeekly).toMatchObject({ usedPercent: 58, resetDescription: '3d' })
    expect(writeActiveClaudeKeychainCredentials).toHaveBeenCalledWith(
      credentialsJson,
      canonicalAuthPath
    )
    expect(deleteActiveClaudeKeychainCredentialsStrict).toHaveBeenCalledWith(canonicalAuthPath)
  })

  it('stages refreshed macOS inactive account credentials before Fable preview', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    const staleCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        expiresAt: Date.now() - 60_000
      }
    })
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    const refreshedCredentialsJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh',
        expiresAt: Date.now() + 3_600_000
      }
    })
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(staleCredentialsJson)
    netFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 }
        }),
        {
          status: 200
        }
      )
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 12,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 34,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      {
        allowUsagePanelSupplement: true,
        // Why: the refresh itself now happens only inside the runtime-auth-service callback.
        prepareCredentials: async () => ({
          status: 'ready',
          credentialsJson: refreshedCredentialsJson,
          deferred: false
        })
      }
    )

    const stagedCredentialsJson = vi.mocked(writeActiveClaudeKeychainCredentials).mock.calls[0]?.[0]
    expect(result.fableWeekly).toMatchObject({
      usedPercent: 58,
      resetDescription: '3d'
    })
    expect(JSON.parse(stagedCredentialsJson ?? '{}')).toMatchObject({
      claudeAiOauth: {
        accessToken: 'fresh-access',
        refreshToken: 'fresh-refresh'
      }
    })
    // The fetcher no longer persists rotations itself; the callback owns the write-back.
    expect(writeManagedClaudeKeychainCredentials).not.toHaveBeenCalled()
  })

  it('does not merge macOS inactive Fable preview when usage windows belong to another account', async () => {
    setPlatform('darwin')
    tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
    appGetPathMock.mockReturnValue(tempDir)
    const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
    mkdirSync(ownedAuthPath, { recursive: true })
    writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
    vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'managed-keychain-token',
          expiresAt: Date.now() + 3_600_000
        }
      })
    )
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: {
        usedPercent: 91,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      weekly: {
        usedPercent: 3,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok'
    })

    const result = await fetchManagedAccountUsage(
      { id: 'account-1', managedAuthPath: ownedAuthPath },
      { allowUsagePanelSupplement: true }
    )

    expect(result.fableWeekly).toBeNull()
  })

  describe('inactive managed account refresh and errors', () => {
    function setupLinuxAccount(credentials: Record<string, unknown>): {
      authPath: string
      credentialsPath: string
    } {
      setPlatform('linux')
      tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
      appGetPathMock.mockReturnValue(tempDir)
      const authPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
      mkdirSync(authPath, { recursive: true })
      writeFileSync(join(authPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
      const credentialsPath = join(authPath, '.credentials.json')
      writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: credentials }), 'utf-8')
      return { authPath, credentialsPath }
    }

    const expiredCredentials = {
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() - 60_000
    }

    it('uses the credentials the prepare callback returns for an expiring inactive account', async () => {
      const { authPath, credentialsPath } = setupLinuxAccount(expiredCredentials)
      const prepareCredentials = vi.fn(async () => ({
        status: 'ready' as const,
        credentialsJson: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            expiresAt: Date.now() + 3_600_000
          }
        }),
        deferred: false
      }))
      netFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 }
        })
      })

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { prepareCredentials }
      )

      expect(result.status).toBe('ok')
      expect(prepareCredentials).toHaveBeenCalledWith('account-1')
      // Refresh happens only via the callback: the token endpoint is never contacted here and the
      // fetcher does not write managed storage itself.
      expect(netFetchMock.mock.calls.some(([url]) => String(url).includes('/v1/oauth/token'))).toBe(
        false
      )
      expect(JSON.parse(readFileSync(credentialsPath, 'utf-8')).claudeAiOauth.accessToken).toBe(
        'stale-access'
      )
      const usageCall = netFetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/oauth/usage')
      )
      expect(usageCall?.[1]?.headers?.Authorization).toBe('Bearer fresh-access')
    })

    it('never refreshes an expiring inactive token when no prepare callback is supplied', async () => {
      const { authPath } = setupLinuxAccount(expiredCredentials)
      netFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          five_hour: { utilization: 12 },
          seven_day: { utilization: 34 }
        })
      })

      await fetchManagedAccountUsage({
        id: 'account-1',
        managedAuthPath: authPath
      })

      expect(netFetchMock).toHaveBeenCalledTimes(1)
      expect(String(netFetchMock.mock.calls[0]?.[0])).toContain('/api/oauth/usage')
    })

    it('returns a rate-limited result with retryAtMs on 429 instead of throwing', async () => {
      const { authPath } = setupLinuxAccount({
        accessToken: 'good',
        expiresAt: Date.now() + 3_600_000
      })
      netFetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'retry-after': '120' }
        })
      )
      const before = Date.now()

      const result = await fetchManagedAccountUsage({
        id: 'account-1',
        managedAuthPath: authPath
      })

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('rate-limited')
      expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 120_000)
      expect(result.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 120_000)
    })

    it('classifies a 401 as stale-token when nothing deferred the refresh', async () => {
      const { authPath } = setupLinuxAccount({
        accessToken: 'good',
        expiresAt: Date.now() + 3_600_000
      })
      netFetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))

      const result = await fetchManagedAccountUsage({
        id: 'account-1',
        managedAuthPath: authPath
      })

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('stale-token')
      expect(result.usageMetadata?.deferredByLiveClaudeSession).toBeUndefined()
    })

    it('reports the live-session deferral on a 401 when the callback deferred the refresh', async () => {
      // Inside the CLI's refresh skew but not yet expired: the endpoint is still asked, and its
      // 401 is read as the deferral rather than as a sign-in problem.
      const expiringCredentials = { ...expiredCredentials, expiresAt: Date.now() + 60_000 }
      const { authPath } = setupLinuxAccount(expiringCredentials)
      const prepareCredentials = vi.fn(async () => ({
        status: 'ready' as const,
        credentialsJson: JSON.stringify({ claudeAiOauth: expiringCredentials }),
        deferred: true
      }))
      netFetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { prepareCredentials }
      )

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('deferred-by-live-session')
      expect(result.usageMetadata?.deferredByLiveClaudeSession).toBe(true)
      // The deferral made no refresh call of its own.
      expect(netFetchMock.mock.calls.some(([url]) => String(url).includes('/v1/oauth/token'))).toBe(
        false
      )
    })

    it('lets the callback finish its write-back when the fetch is aborted mid-callback', async () => {
      const { authPath, credentialsPath } = setupLinuxAccount(expiredCredentials)
      const controller = new AbortController()
      const rotated = JSON.stringify({
        claudeAiOauth: { accessToken: 'rotated', refreshToken: 'rotated-r', expiresAt: 9e12 }
      })
      let callbackFinished = false
      const prepareCredentials = vi.fn(async () => {
        controller.abort()
        await Promise.resolve()
        writeFileSync(credentialsPath, rotated, 'utf-8')
        callbackFinished = true
        return { status: 'ready' as const, credentialsJson: rotated, deferred: false }
      })

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { prepareCredentials, signal: controller.signal }
      )

      expect(result.error).toBe('Rate-limit fetch aborted')
      expect(callbackFinished).toBe(true)
      expect(JSON.parse(readFileSync(credentialsPath, 'utf-8')).claudeAiOauth.accessToken).toBe(
        'rotated'
      )
      expect(netFetchMock).not.toHaveBeenCalled()
    })

    it('drops the fetch when the callback says the account became active', async () => {
      const { authPath } = setupLinuxAccount(expiredCredentials)

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { prepareCredentials: async () => ({ status: 'skip' }) }
      )

      expect(result.status).toBe('error')
      expect(netFetchMock).not.toHaveBeenCalled()
    })

    const matchingPtyResult = {
      provider: 'claude' as const,
      session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 34, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      fableWeekly: {
        usedPercent: 58,
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: '3d'
      },
      updatedAt: 1,
      error: null,
      status: 'ok' as const
    }

    it('spawns no PTY preview while the refresh is deferred behind a live terminal', async () => {
      // Expiring (inside the CLI's 5 minute skew) but not yet expired, so the usage call still runs.
      const expiring = { accessToken: 'soon', refreshToken: 'r', expiresAt: Date.now() + 60_000 }
      const { authPath } = setupLinuxAccount(expiring)
      netFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } })
      })

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        {
          allowUsagePanelSupplement: true,
          prepareCredentials: async () => ({
            status: 'ready',
            credentialsJson: JSON.stringify({ claudeAiOauth: expiring }),
            deferred: true
          })
        }
      )

      expect(result.status).toBe('ok')
      expect(fetchViaPty).not.toHaveBeenCalled()
    })

    it('spawns no PTY preview while the token is expiring and was not refreshed', async () => {
      const { authPath } = setupLinuxAccount({
        accessToken: 'soon',
        refreshToken: 'r',
        expiresAt: Date.now() + 60_000
      })
      netFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } })
      })

      await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { allowUsagePanelSupplement: true }
      )

      expect(fetchViaPty).not.toHaveBeenCalled()
    })

    it('still spawns the PTY preview for a healthy, non-expiring token (positive control)', async () => {
      const { authPath } = setupLinuxAccount({
        accessToken: 'healthy',
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000
      })
      netFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } })
      })
      vi.mocked(fetchViaPty).mockResolvedValueOnce(matchingPtyResult)

      await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        { allowUsagePanelSupplement: true }
      )

      expect(fetchViaPty).toHaveBeenCalledTimes(1)
    })

    it('returns the deferral without calling the usage endpoint when deferred and already expired', async () => {
      const { authPath } = setupLinuxAccount(expiredCredentials)

      const result = await fetchManagedAccountUsage(
        { id: 'account-1', managedAuthPath: authPath },
        {
          prepareCredentials: async () => ({
            status: 'ready',
            credentialsJson: JSON.stringify({ claudeAiOauth: expiredCredentials }),
            deferred: true
          })
        }
      )

      expect(result.usageMetadata?.failureKind).toBe('deferred-by-live-session')
      expect(netFetchMock).not.toHaveBeenCalled()
    })

    describe('macOS staged usage-panel credentials', () => {
      async function runWithStagedBlob(staged: string): Promise<void> {
        setPlatform('darwin')
        tempDir = mkdtempSync(join(tmpdir(), 'orca-claude-fetcher-'))
        appGetPathMock.mockReturnValue(tempDir)
        const ownedAuthPath = join(tempDir, 'claude-accounts', 'account-1', 'auth')
        mkdirSync(ownedAuthPath, { recursive: true })
        writeFileSync(join(ownedAuthPath, '.orca-managed-claude-auth'), 'account-1\n', 'utf-8')
        vi.mocked(readManagedClaudeKeychainCredentials).mockResolvedValueOnce(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: 'managed',
              refreshToken: 'managed-refresh',
              expiresAt: Date.now() + 3_600_000
            }
          })
        )
        vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValue(staged)
        vi.mocked(fetchViaPty).mockResolvedValueOnce(matchingPtyResult)
        await fetchManagedAccountUsage(
          { id: 'account-1', managedAuthPath: ownedAuthPath },
          { allowUsagePanelSupplement: true }
        )
      }

      it('never writes back a staged blob the CLI wiped to empty tokens', async () => {
        await runWithStagedBlob(
          JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } })
        )

        expect(fetchViaPty).toHaveBeenCalledTimes(1)
        expect(writeManagedClaudeKeychainCredentials).not.toHaveBeenCalled()
      })

      it('never writes back a staged blob that kept an access token but lost the refresh token', async () => {
        await runWithStagedBlob(
          JSON.stringify({ claudeAiOauth: { accessToken: 'still-here', refreshToken: '' } })
        )

        expect(writeManagedClaudeKeychainCredentials).not.toHaveBeenCalled()
      })

      it('writes back a staged blob the CLI legitimately rotated (positive control)', async () => {
        const rotated = JSON.stringify({
          claudeAiOauth: {
            accessToken: 'rotated',
            refreshToken: 'rotated-refresh',
            expiresAt: Date.now() + 7_200_000
          }
        })
        await runWithStagedBlob(rotated)

        expect(writeManagedClaudeKeychainCredentials).toHaveBeenCalledWith('account-1', rotated)
      })
    })

    it('marks missing credentials with the missing-credentials failure kind', async () => {
      const { authPath } = setupLinuxAccount({ refreshToken: 'only-refresh' })
      writeFileSync(join(authPath, '.credentials.json'), 'null', 'utf-8')

      const result = await fetchManagedAccountUsage({
        id: 'account-1',
        managedAuthPath: authPath
      })

      expect(result.error).toBe('No credentials')
      expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    })
  })
})
