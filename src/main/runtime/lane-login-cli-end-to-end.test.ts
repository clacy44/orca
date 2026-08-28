/**
 * S9-L1 §modules E — the end-to-end host test the task's own risk list calls for: NOT the
 * `spawnClaudeCliChildProcess` mock every other suite in this slice uses, but a real `claude`
 * binary (a fake one, written to a temp PATH entry) spawned through the REAL composition root
 * (`attachPrincipalLaneHost`, the RPC method table) — loginStartInline -> loginSubmitCodeInline
 * -> captured, then logoutInline, then the "two entry points, one session" refusal in both
 * directions. `readOnly against /opt/orca` etc. is irrelevant here: nothing touches the real
 * production orca serve or any installed `claude` — the fake binary is the ONLY thing on the
 * prepended PATH entry, isolated to this test's own temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_CREDENTIAL_LANE_METHODS } from './rpc/methods/claude-credential-lanes'
import { attachPrincipalLaneHost, detachPrincipalLaneHost } from './principal-lane-host-wiring'
import { setLaneWireHostDependencies } from './lane-wire-composition'
import { attachLaneWireService } from './lane-wire-service'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { readLaneAccountIndex } from '../claude-accounts/lane-account-index'
import { LAST_VERIFIED_CLI_VERSION } from '../claude-accounts/lane-login-cli-version-gate'
import type { PrincipalGrantRow } from './principal-registry'
import { PrincipalRegistry } from './principal-registry'
import { authorizeHostConsent } from './principal-consent-authority'
import { isStreamingMethod, type RpcContext } from './rpc/core'
import { resetLaneWipePendingForTests } from '../claude-accounts/lane-wipe-pending'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true
  add(deviceId: string): void {
    this.rows.push({
      deviceId,
      name: 'Ana',
      token: `token-${deviceId}`,
      pairedAt: 1,
      lastSeenAt: 1,
      pendingExpiresAt: Date.now() + 60_000
    })
  }
  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((row) => row.deviceId === deviceId) ?? null
  }
  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

/**
 * A minimal, real `claude` CLI stand-in: `--version` (the real version gate probes it),
 * `auth login --claudeai` (prints the OSC-8-wrapped `platform.claude.com` authorize URL, the
 * paste prompt with NO trailing newline, reads one code line from stdin, writes
 * `.credentials.json`/`.claude.json` into its own `CLAUDE_CONFIG_DIR`, exits), and
 * `auth status --json` (reports the email the login step just wrote). Any other invocation exits
 * non-zero — a real login-session failure mode this test does not exercise.
 */
function fakeClaudeScript(): string {
  return `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
const configDir = process.env.CLAUDE_CONFIG_DIR

if (args[0] === '--version') {
  process.stdout.write('${LAST_VERIFIED_CLI_VERSION} (Claude Code)\\n', () => process.exit(0))
} else if (args[0] === 'auth' && args[1] === 'status') {
  let email = null
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'))
    email = (parsed.oauthAccount && parsed.oauthAccount.emailAddress) || null
  } catch {}
  process.stdout.write(JSON.stringify({ email }), () => process.exit(0))
} else if (args[0] === 'auth' && args[1] === 'login') {
  const url =
    'https://platform.claude.com/oauth/authorize?redirect_uri=' +
    encodeURIComponent('https://platform.claude.com/oauth/code/callback')
  const OSC8_OPEN = '\\x1b]8;;'
  const OSC8_CLOSE = '\\x1b\\\\'
  process.stdout.write('Open this link in your browser:\\n')
  process.stdout.write(OSC8_OPEN + url + OSC8_CLOSE + url + OSC8_OPEN + OSC8_CLOSE + '\\n')
  process.stdout.write('Paste code here if prompted > ')
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const idx = buffer.indexOf('\\n')
    if (idx === -1) return
    const code = buffer.slice(0, idx).trim()
    if (!code) return
    const email = process.env.FAKE_CLAUDE_LOGIN_EMAIL || 'nobody@example.com'
    fs.writeFileSync(
      path.join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-at', refreshToken: 'fake-rt' } })
    )
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    )
    process.stdout.write('\\nLogin successful.\\n', () => process.exit(0))
  })
} else {
  process.exit(1)
}
`
}

let userDataPath = ''
let binDir = ''
let originalPath: string | undefined
let originalFakeEmail: string | undefined

function methodHandler(name: string) {
  const method = CLAUDE_CREDENTIAL_LANE_METHODS.find((candidate) => candidate.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`missing ${name}`)
  }
  return method
}

/** Host-only: the CLI's own local-socket connection, never a paired grant. */
const HOST_CTX = {} as RpcContext

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-lane-e2e-'))
  binDir = mkdtempSync(join(tmpdir(), 'orca-lane-e2e-bin-'))
  writeFileSync(join(binDir, 'claude'), fakeClaudeScript(), { mode: 0o755 })
  originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${originalPath ?? ''}`
  originalFakeEmail = process.env.FAKE_CLAUDE_LOGIN_EMAIL
  resetLaneWipePendingForTests()
})

afterEach(() => {
  detachPrincipalLaneHost({})
  attachLaneWireService(null)
  setLaneWireHostDependencies(null)
  resetLaneWipePendingForTests()
  process.env.PATH = originalPath
  if (originalFakeEmail === undefined) {
    delete process.env.FAKE_CLAUDE_LOGIN_EMAIL
  } else {
    process.env.FAKE_CLAUDE_LOGIN_EMAIL = originalFakeEmail
  }
  rmSync(userDataPath, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
}, 20_000)

describe('S9-L1 host-inline login, end to end through a real `claude` child process', () => {
  it('loginStartInline -> loginSubmitCodeInline -> captured, then logoutInline -> wiped + index purged', async () => {
    const lanesRoot = join(userDataPath, 'claude-lanes')
    const grants = new FakeGrants()
    const consent = authorizeHostConsent({})
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const principal = setupRegistry.createPrincipal(consent, 'Ana')
    provisionPrincipalLane(principal.principalId, { lanesRoot, platform: 'linux' })

    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })
    attachPrincipalLaneHost({ userDataPath, grants, runtimeAuthToken: 'test-token', runtime: {} })

    process.env.FAKE_CLAUDE_LOGIN_EMAIL = 'ana@example.com'

    const startMethod = methodHandler('accounts.lane.loginStartInline')
    const startParams = startMethod.params!.parse({
      principalId: principal.principalId,
      expectedEmail: 'ana@example.com'
    })
    const started = (await startMethod.handler(startParams, HOST_CTX)) as {
      loginSessionId: string
      authorizeUrl: string
    }
    expect(started.authorizeUrl).toBe(
      `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}`
    )

    const submitMethod = methodHandler('accounts.lane.loginSubmitCodeInline')
    const submitParams = submitMethod.params!.parse({
      principalId: principal.principalId,
      loginSessionId: started.loginSessionId,
      code: '123456'
    })
    const submitted = (await submitMethod.handler(submitParams, HOST_CTX)) as {
      status: string
      identity: { email: string } | null
    }
    expect(submitted.status).toBe('completed')
    expect(submitted.identity?.email).toBe('ana@example.com')

    const laneDir = join(lanesRoot, principal.principalId)
    expect(existsSync(join(laneDir, '.credentials.json'))).toBe(true)
    expect(coordinator.store.getLaneState(principal.principalId)).toBe('loaded')
    const rows = readLaneAccountIndex(join(laneDir, 'claude-accounts'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'ana@example.com', active: true })

    const logoutMethod = methodHandler('accounts.lane.logoutInline')
    const logoutParams = logoutMethod.params!.parse({ principalId: principal.principalId })
    const loggedOut = (await logoutMethod.handler(logoutParams, HOST_CTX)) as {
      cleared: string[]
    }
    expect(loggedOut.cleared).toContain('.credentials.json')
    expect(existsSync(join(laneDir, '.credentials.json'))).toBe(false)
    expect(existsSync(join(laneDir, 'claude-accounts', 'index.json'))).toBe(false)
    expect(coordinator.store.getLaneState(principal.principalId)).toBe('absent')
  }, 20_000)

  it('"two entry points, one session": a grant-started login refuses a host-inline start, and vice versa', async () => {
    const lanesRoot = join(userDataPath, 'claude-lanes')
    const grants = new FakeGrants()
    grants.add('desktop-a')
    const consent = authorizeHostConsent({})
    const setupRegistry = new PrincipalRegistry(userDataPath, grants)
    const principal = setupRegistry.createPrincipal(consent, 'Ana')
    setupRegistry.bindGrant(consent, 'desktop-a', principal.principalId)
    setupRegistry.designatePusher(consent, principal.principalId, 'desktop-a')
    provisionPrincipalLane(principal.principalId, { lanesRoot, platform: 'linux' })

    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' }
    })
    setLaneWireHostDependencies({ coordinator })
    attachPrincipalLaneHost({ userDataPath, grants, runtimeAuthToken: 'test-token', runtime: {} })

    const grantStart = methodHandler('accounts.lane.loginStart')
    const inlineStart = methodHandler('accounts.lane.loginStartInline')
    const grantCancel = methodHandler('accounts.lane.loginCancel')
    const inlineCancel = methodHandler('accounts.lane.loginCancelInline')

    // Direction 1: a grant-started session blocks the host-inline entry point.
    const grantStarted = (await grantStart.handler(
      grantStart.params!.parse({ expectedEmail: 'a@x.com' }),
      { pairedDeviceId: 'desktop-a' } as RpcContext
    )) as { loginSessionId: string }
    await expect(
      inlineStart.handler(
        inlineStart.params!.parse({ principalId: principal.principalId, expectedEmail: 'a@x.com' }),
        HOST_CTX
      )
    ).rejects.toMatchObject({ code: 'accounts.lane.login_already_in_flight' })
    await grantCancel.handler(
      grantCancel.params!.parse({ loginSessionId: grantStarted.loginSessionId }),
      { pairedDeviceId: 'desktop-a' } as RpcContext
    )

    // Direction 2: a host-inline session blocks the grant entry point.
    await inlineStart.handler(
      inlineStart.params!.parse({ principalId: principal.principalId, expectedEmail: 'a@x.com' }),
      HOST_CTX
    )
    await expect(
      grantStart.handler(grantStart.params!.parse({ expectedEmail: 'a@x.com' }), {
        pairedDeviceId: 'desktop-a'
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'accounts.lane.login_already_in_flight' })
    await inlineCancel.handler(
      inlineCancel.params!.parse({ principalId: principal.principalId }),
      HOST_CTX
    )
  }, 20_000)
})
