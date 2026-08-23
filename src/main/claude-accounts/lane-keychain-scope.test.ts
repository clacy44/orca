import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaneCredentialWriter } from './lane-credential-writer'
import { wipeLaneCredentials } from './principal-lane-credential-sweep'

/**
 * §2i's mandated in-repo control: a lane resolves the SCOPED Keychain service and NOTHING else.
 *
 * Nothing here injects a Keychain double — that is the whole point. The tests beside these pin the
 * lane writer's and the wipe's SEQUENCE through an injected fake, which cannot see which service
 * the production default names; this file drives the real defaults over a mocked `security` so
 * that any lane path reaching the host-wide unsuffixed service turns a named test red. That
 * failure class — every lane silently collapsing onto one credential under a pre-2.1 CLI, R1 and
 * R3 failing with no symptom — is the worst in the design, so it fails in CI and not only in the
 * §5 manual probe.
 */
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn()
}))

const execFileMock = vi.mocked(execFile)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
const UNSUFFIXED_SERVICE = 'Claude Code-credentials'

/** The service Claude Code 2.1+ derives for a config dir; a lane must name only this one. */
function scopedServiceFor(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${UNSUFFIXED_SERVICE}-${suffix}`
}

function securityArgs(): string[][] {
  return execFileMock.mock.calls.map((call) => call[1] as string[])
}

describe('a lane resolves the scoped Keychain service only', () => {
  let laneDir = ''

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-keychain-'))
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    execFileMock.mockReset()
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      ;(callback as (error: Error | null, stdout: string, stderr: string) => void)(null, '', '')
      return null as never
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(laneDir, { recursive: true, force: true })
  })

  it('writes one add-generic-password, naming the lane-scoped service', async () => {
    await new LaneCredentialWriter({ platform: 'darwin' }).writeCredentials(laneDir, CREDENTIALS)

    expect(securityArgs()).toEqual([
      [
        'add-generic-password',
        '-U',
        '-s',
        scopedServiceFor(laneDir),
        '-a',
        process.env.USER || process.env.USERNAME || 'user',
        '-w',
        CREDENTIALS
      ]
    ])
    // The `[scoped, unsuffixed]` walk would publish this lane's credential host-wide.
    expect(securityArgs().flat()).not.toContain(UNSUFFIXED_SERVICE)
  })

  it('wipes one delete-generic-password, naming the lane-scoped service', async () => {
    writeFileSync(join(laneDir, '.credentials.json'), CREDENTIALS, { mode: 0o600 })

    await wipeLaneCredentials(laneDir, { platform: 'darwin' })

    expect(securityArgs()).toEqual([
      [
        'delete-generic-password',
        '-s',
        scopedServiceFor(laneDir),
        '-a',
        process.env.USER || process.env.USERNAME || 'user'
      ]
    ])
    // Deleting the unsuffixed item would sign every OTHER lane's older CLI out.
    expect(securityArgs().flat()).not.toContain(UNSUFFIXED_SERVICE)
  })

  it('names a different service for a different lane, which is what keeps R1 true', async () => {
    const otherLane = mkdtempSync(join(tmpdir(), 'orca-lane-keychain-b-'))
    try {
      const writer = new LaneCredentialWriter({ platform: 'darwin' })
      await writer.writeCredentials(laneDir, CREDENTIALS)
      await writer.writeCredentials(otherLane, CREDENTIALS)
      const services = securityArgs().map((args) => args[3])
      expect(services).toEqual([scopedServiceFor(laneDir), scopedServiceFor(otherLane)])
      expect(services[0]).not.toBe(services[1])
    } finally {
      rmSync(otherLane, { recursive: true, force: true })
    }
  })
})
