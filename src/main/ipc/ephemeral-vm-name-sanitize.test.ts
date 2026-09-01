import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { listEnvironments } from '../../shared/runtime-environment-store'

// S10-15 review M-3: split out of ephemeral-vm.test.ts (max-lines ratchet) — a repo display
// name containing '@'/':' (e.g. a scoped package name) used to reach the S10-15 finding-16
// door validator unsanitized and tear down a just-provisioned VM when
// addEnvironmentFromPairingCode refused the auto-generated environment name.
const handlers = new Map<string, (_event: unknown, args: never) => unknown>()
const {
  handleMock,
  removeHandlerMock,
  getPathMock,
  connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTargetMock,
  removeRuntimeOwnedSshTargetMock,
  invalidateRuntimeEnvironmentTransportMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getPathMock: vi.fn(),
  connectRuntimeOwnedSshTargetMock: vi.fn(),
  disconnectRuntimeOwnedSshTargetMock: vi.fn(),
  removeRuntimeOwnedSshTargetMock: vi.fn(),
  invalidateRuntimeEnvironmentTransportMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connectRuntimeOwnedSshTargetMock,
  disconnectRuntimeOwnedSshTarget: disconnectRuntimeOwnedSshTargetMock,
  removeRuntimeOwnedSshTarget: removeRuntimeOwnedSshTargetMock
}))

vi.mock('./runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: invalidateRuntimeEnvironmentTransportMock
}))

import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  removeHandlerMock.mockReset()
  getPathMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: never) => {
    handlers.set(channel, handler)
  })
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('ephemeral VM environment name sanitize (S10-15 review M-3)', () => {
  it('sanitizes a scoped repo display name ("@scope/app") into a valid environment name', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-sanitize-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-sanitize-repo-')
    getPathMock.mockReturnValue(userDataPath)
    mkdirSync(join(repoPath, 'scripts'), { recursive: true })
    const startPath = join(repoPath, 'scripts', 'start.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
        '}))'
      ].join('\n')
    )
    writeFileSync(
      join(repoPath, 'orca.yaml'),
      [
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        `    create: ${JSON.stringify(nodeCommand(startPath))}`,
        '    destroy: none'
      ].join('\n')
    )

    const scopedRepo = {
      id: 'repo-1',
      path: repoPath,
      displayName: '@scope/app',
      badgeColor: '#000',
      addedAt: 0
    }
    let activeRuntimeEnvironmentId: string | null = null
    const store = {
      getRepo: vi.fn((repoId: string) => (repoId === 'repo-1' ? scopedRepo : null)),
      getRepos: vi.fn(() => [scopedRepo]),
      getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId })),
      updateSettings: vi.fn((updates: { activeRuntimeEnvironmentId: string | null }) => {
        activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
      })
    }
    registerEphemeralVmHandlers(store as never)
    const result = (await handlers.get('ephemeralVm:provision')?.(null, {
      repoId: 'repo-1',
      recipeId: 'cloud-sandbox',
      workspaceName: 'Fix Login Race'
    } as never)) as {
      ok: boolean
      environment?: { id: string; name: string }
    }

    expect(result.ok).toBe(true)
    expect(result.environment?.name).not.toContain('@')
    expect(result.environment?.name).not.toContain(':')
    expect(result.environment?.name).toContain('-scope/app VM ')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })
})
