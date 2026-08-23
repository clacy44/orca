import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertPrincipalId,
  deprovisionPrincipalLane,
  getPrincipalLaneDir,
  isPrincipalId,
  openPrincipalLane,
  provisionPrincipalLane,
  requiresVerifiedWindowsDacl,
  resolveOwnedPrincipalLaneDir
} from './principal-credential-lane'
import {
  isLaneLoaded,
  sweepLaneCredentialTempArtifacts,
  wipeLaneCredentials
} from './principal-lane-credential-sweep'
import { formatLaneProvenance, readLaneProvenanceLabel } from './principal-lane-provenance'
import { reconcileOrphanPrincipalLanes } from './principal-lane-orphan-reconciliation'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const PRINCIPAL_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const PRINCIPAL_B = '11112222-3333-4444-8555-666677778888'

describe('principal credential lane', () => {
  let userData = ''
  let lanesRoot = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lane-'))
    lanesRoot = join(userData, 'claude-lanes')
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  const options = (): { lanesRoot: string; platform: NodeJS.Platform } => ({
    lanesRoot,
    platform: 'linux'
  })

  describe('principal id validation at creation', () => {
    it('accepts the exact randomUUID shape the registry mints', () => {
      expect(isPrincipalId(PRINCIPAL_A)).toBe(true)
    })

    it('refuses a 36-character non-UUID lane id at creation', () => {
      const notAUuid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
      expect(notAUuid).toHaveLength(36)

      expect(() => assertPrincipalId(notAUuid)).toThrow(/host-minted UUID shape/)
      expect(() => getPrincipalLaneDir(notAUuid, options())).toThrow(/host-minted UUID shape/)
      expect(() => provisionPrincipalLane(notAUuid, options())).toThrow(/host-minted UUID shape/)
      expect(existsSync(join(lanesRoot, notAUuid))).toBe(false)
    })

    it('refuses a traversal segment before it can reach path.join', () => {
      expect(() => getPrincipalLaneDir('../escape', options())).toThrow(/host-minted UUID shape/)
    })
  })

  describe('provisioning', () => {
    it('creates <lanesRoot>/<principalId> at 0700 with an owning marker', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())

      expect(lane.laneDir).toBe(join(lanesRoot, PRINCIPAL_A))
      expect(statSync(lane.laneDir).mode & 0o777).toBe(0o700)
      expect(readFileSync(join(lane.laneDir, '.orca-principal-lane'), 'utf-8').trim()).toBe(
        PRINCIPAL_A
      )
    })

    it('mints an opaque provenance label that carries neither the principal id nor a device id', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())

      expect(lane.provenanceLabel).toMatch(/^[0-9a-f]{32}$/)
      expect(lane.provenanceLabel).not.toContain(PRINCIPAL_A)
      expect(formatLaneProvenance(lane.provenanceLabel)).toBe(`lane:${lane.provenanceLabel}`)
      expect(readLaneProvenanceLabel(lane.laneDir)).toBe(lane.provenanceLabel)
    })

    it('keeps the same label across a re-provision', () => {
      const first = provisionPrincipalLane(PRINCIPAL_A, options())
      const second = provisionPrincipalLane(PRINCIPAL_A, options())

      expect(second.provenanceLabel).toBe(first.provenanceLabel)
    })

    it('refuses a lane directory carrying another principal’s marker', () => {
      const laneDir = join(lanesRoot, PRINCIPAL_A)
      mkdirSync(laneDir, { recursive: true })
      writeFileSync(join(laneDir, '.orca-principal-lane'), `${PRINCIPAL_B}\n`)

      expect(() => provisionPrincipalLane(PRINCIPAL_A, options())).toThrow(
        /not marked as this person/
      )
    })
  })

  describe('ownership discipline', () => {
    it('resolves a provisioned lane it owns', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())

      expect(resolveOwnedPrincipalLaneDir(PRINCIPAL_A, options())).toBe(realpathOf(lane.laneDir))
    })

    it('refuses a lane that is a symlink out of the root', () => {
      const outside = join(userData, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, '.orca-principal-lane'), `${PRINCIPAL_A}\n`)
      mkdirSync(lanesRoot, { recursive: true })
      symlinkSync(outside, join(lanesRoot, PRINCIPAL_A))

      expect(resolveOwnedPrincipalLaneDir(PRINCIPAL_A, options())).toBeNull()
    })

    it('refuses a lane with a foreign marker', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())
      writeFileSync(join(lane.laneDir, '.orca-principal-lane'), `${PRINCIPAL_B}\n`)

      expect(resolveOwnedPrincipalLaneDir(PRINCIPAL_A, options())).toBeNull()
    })

    it('refuses a lane with no marker at all', () => {
      mkdirSync(join(lanesRoot, PRINCIPAL_A), { recursive: true })

      expect(resolveOwnedPrincipalLaneDir(PRINCIPAL_A, options())).toBeNull()
      expect(openPrincipalLane(PRINCIPAL_A, options())).toBeNull()
    })

    it('refuses a nested wrong-segment candidate', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())
      const nested = join(lane.laneDir, PRINCIPAL_B)
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, '.orca-principal-lane'), `${PRINCIPAL_B}\n`)

      // A two-segment candidate is not a lane: the lane key is one segment under the root.
      expect(resolveOwnedPrincipalLaneDir(PRINCIPAL_B, options())).toBeNull()
    })
  })

  describe('credential sweep', () => {
    const plantArtifacts = (laneDir: string): void => {
      writeFileSync(join(laneDir, '.credentials.json'), '{"claudeAiOauth":{}}', { mode: 0o600 })
      writeFileSync(join(laneDir, `.credentials.json.4242.${'a'.repeat(8)}.tmp`), 'blob', {
        mode: 0o600
      })
      writeFileSync(join(laneDir, '.credentials.json.4242.1700000000000.abcd1234.tmp'), 'blob', {
        mode: 0o600
      })
      writeFileSync(join(laneDir, 'settings.json'), '{"hooks":{}}')
      mkdirSync(join(laneDir, 'projects'), { recursive: true })
      writeFileSync(join(laneDir, 'projects', 'transcript.jsonl'), '{}')
    }

    it('wipes the credential and every tmp sibling while keeping settings and transcripts', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())
      plantArtifacts(lane.laneDir)
      writeFileSync(
        join(lane.laneDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' }, theme: 'dark' })
      )

      const removed = wipeLaneCredentials(lane.laneDir)

      expect(existsSync(join(lane.laneDir, '.credentials.json'))).toBe(false)
      expect(removed.filter((name) => name.endsWith('.tmp'))).toHaveLength(2)
      expect(existsSync(join(lane.laneDir, 'settings.json'))).toBe(true)
      expect(existsSync(join(lane.laneDir, 'projects', 'transcript.jsonl'))).toBe(true)
      const config = JSON.parse(
        readFileSync(join(lane.laneDir, '.claude.json'), 'utf-8')
      ) as Record<string, unknown>
      expect('oauthAccount' in config).toBe(false)
      expect(config.theme).toBe('dark')
      expect(isLaneLoaded(lane.laneDir)).toBe(false)
    })

    it('sweeps a planted tmp blob on the next lane open while leaving the credential', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())
      plantArtifacts(lane.laneDir)

      const opened = openPrincipalLane(PRINCIPAL_A, options())

      expect(opened).toBe(realpathOf(lane.laneDir))
      expect(
        sweepLaneCredentialTempArtifacts(lane.laneDir),
        'the open sweep already removed every staged blob'
      ).toHaveLength(0)
      expect(isLaneLoaded(lane.laneDir)).toBe(true)
    })
  })

  describe('deprovision', () => {
    it('removes the lane directory it owns', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())

      expect(deprovisionPrincipalLane(PRINCIPAL_A, options())).toBe(true)
      expect(existsSync(lane.laneDir)).toBe(false)
    })

    it('refuses to remove a directory it does not own', () => {
      const laneDir = join(lanesRoot, PRINCIPAL_A)
      mkdirSync(laneDir, { recursive: true })

      expect(deprovisionPrincipalLane(PRINCIPAL_A, options())).toBe(false)
      expect(existsSync(laneDir)).toBe(true)
    })
  })

  describe('orphan reconciliation', () => {
    it('deletes a lane no surviving bound grant claims', () => {
      provisionPrincipalLane(PRINCIPAL_A, options())
      provisionPrincipalLane(PRINCIPAL_B, options())

      const result = reconcileOrphanPrincipalLanes({
        boundPrincipalIds: [PRINCIPAL_A],
        registryLoadSucceeded: true,
        lanesRoot
      })

      expect(result.deletedPrincipalIds).toEqual([PRINCIPAL_B])
      expect(existsSync(join(lanesRoot, PRINCIPAL_A))).toBe(true)
      expect(existsSync(join(lanesRoot, PRINCIPAL_B))).toBe(false)
    })

    it('deletes nothing when the device registry load threw', () => {
      provisionPrincipalLane(PRINCIPAL_A, options())
      provisionPrincipalLane(PRINCIPAL_B, options())

      const result = reconcileOrphanPrincipalLanes({
        boundPrincipalIds: [],
        registryLoadSucceeded: false,
        lanesRoot
      })

      expect(result.skipped).toBe('registry-load-failed')
      expect(existsSync(join(lanesRoot, PRINCIPAL_A))).toBe(true)
      expect(existsSync(join(lanesRoot, PRINCIPAL_B))).toBe(true)
    })

    it('deletes nothing when a successful load reports zero bound grants', () => {
      provisionPrincipalLane(PRINCIPAL_A, options())

      const result = reconcileOrphanPrincipalLanes({
        boundPrincipalIds: [],
        registryLoadSucceeded: true,
        lanesRoot
      })

      expect(result.skipped).toBe('registry-empty')
      expect(existsSync(join(lanesRoot, PRINCIPAL_A))).toBe(true)
    })

    it('leaves a foreign directory under the lanes root alone', () => {
      provisionPrincipalLane(PRINCIPAL_A, options())
      const foreign = join(lanesRoot, 'not-a-lane')
      mkdirSync(foreign, { recursive: true })

      reconcileOrphanPrincipalLanes({
        boundPrincipalIds: [PRINCIPAL_A],
        registryLoadSucceeded: true,
        lanesRoot
      })

      expect(existsSync(foreign)).toBe(true)
    })
  })

  describe('win32 lane hardening', () => {
    it('fails provisioning closed when the DACL cannot be verified', () => {
      const attempted: [string, boolean][] = []

      expect(() =>
        provisionPrincipalLane(PRINCIPAL_A, {
          lanesRoot,
          platform: 'win32',
          restrictWindowsPath: (target, isDirectory) => {
            attempted.push([target, isDirectory])
            return false
          }
        })
      ).toThrow(/could not verify this credential lane/)
      expect(attempted).toEqual([[join(lanesRoot, PRINCIPAL_A), true]])
      expect(existsSync(join(lanesRoot, PRINCIPAL_A))).toBe(false)
    })

    it('provisions when the DACL verifies', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, {
        lanesRoot,
        platform: 'win32',
        restrictWindowsPath: () => true
      })

      expect(existsSync(join(lane.laneDir, '.orca-principal-lane'))).toBe(true)
    })

    it('leaves an existing lane in place when a re-provision cannot verify its DACL', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_A, options())
      writeFileSync(join(lane.laneDir, '.credentials.json'), '{"claudeAiOauth":{}}')

      expect(() =>
        provisionPrincipalLane(PRINCIPAL_A, {
          lanesRoot,
          platform: 'win32',
          restrictWindowsPath: () => false
        })
      ).toThrow(/could not verify this credential lane/)
      expect(existsSync(join(lane.laneDir, '.credentials.json'))).toBe(true)
    })

    it('skips the DACL step for a wsl.localhost lane root and requires it for a local drive', () => {
      expect(
        requiresVerifiedWindowsDacl(
          '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-lanes\\lane',
          'win32'
        )
      ).toBe(false)
      expect(requiresVerifiedWindowsDacl('C:\\Users\\dev\\claude-lanes\\lane', 'win32')).toBe(true)
      expect(requiresVerifiedWindowsDacl('C:\\Users\\dev\\claude-lanes\\lane', 'linux')).toBe(false)
    })
  })

  describe.runIf(process.platform === 'win32')('win32 lane hardening, real ACL', () => {
    it('provisions a lane whose DACL the real call verifies', () => {
      const lane = provisionPrincipalLane(PRINCIPAL_B, { lanesRoot, platform: 'win32' })

      expect(existsSync(join(lane.laneDir, '.orca-principal-lane'))).toBe(true)
    })
  })
})

// Why: macOS resolves /var to /private/var, so compare against the canonical form.
function realpathOf(path: string): string {
  return realpathSync.native(path)
}
