/**
 * The closure principle at the one site where the host RE-DERIVES a launch from host-wide
 * settings: a second grant's `settings.update({ agentDefaultArgs, agentDefaultEnv })` must reach
 * no lane launch, on either branch of `resolveAgentTerminalCreateOptions` (S9 §2 rows 13/14/17).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { laneScopedAgentLaunchSettings } from './lane-launch-computation'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PEER_SETTINGS = {
  agentDefaultArgs: { claude: '--settings /tmp/b.json' },
  agentDefaultEnv: { claude: { ANTHROPIC_API_KEY: 'peer-key' } },
  agentCmdOverrides: { claude: 'claude-from-a-peer' }
}

const principals: PrincipalLookup = {
  principalOf: (deviceId) => (deviceId === 'device-a' ? PRINCIPAL_A : null),
  linkPrincipalOf: () => null
}

function createRuntime(): { runtime: OrcaRuntimeService; spawn: ReturnType<typeof vi.fn> } {
  const store = {
    getSettings: () => PEER_SETTINGS
  } as unknown as ConstructorParameters<typeof OrcaRuntimeService>[0]
  const runtime = new OrcaRuntimeService(store)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    markLocalWorkspaceTrustedForAgent: (agent: string, path: string) => void
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: null,
    repo: { id: 'repo-1', path: '/repo' },
    folderWorkspace: null
  })
  vi.spyOn(internals, 'markLocalWorkspaceTrustedForAgent').mockImplementation(() => {})
  runtime.setPrincipalLaneLookup(principals)
  const spawn = vi.fn().mockImplementation(async (args: { tabId?: string; leafId?: string }) => ({
    id: `pty-${args.tabId}-${args.leafId}`
  }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn }
}

describe('a peer’s host-wide launch settings against a lane launch', () => {
  it.each([
    ['the bare-agent branch', { command: 'claude' }],
    ['the startupAgent branch', { startupAgent: 'claude' as const }]
  ])('reaches neither the command nor the env on %s', async (_branch, launch) => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal('id:wt-1', {
      credentialLane: runtime.resolveCallerCredentialLane('device-a'),
      ...launch
    })

    const spawned = spawn.mock.calls[0][0] as {
      command?: string
      env?: Record<string, string>
    }
    expect(spawned.command).not.toContain('--settings')
    expect(spawned.command).not.toContain('claude-from-a-peer')
    expect(spawned.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('still applies them to a shared-lane launch', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal('id:wt-1', {
      credentialLane: { kind: 'shared' },
      command: 'claude'
    })

    const spawned = spawn.mock.calls[0][0] as { command?: string; env?: Record<string, string> }
    expect(spawned.command).toContain('--settings')
    expect(spawned.command).toContain('/tmp/b.json')
    expect(spawned.command).toContain('claude-from-a-peer')
    expect(spawned.env?.ANTHROPIC_API_KEY).toBe('peer-key')
  })
})

describe('laneScopedAgentLaunchSettings', () => {
  it('empties all three for a lane, leaving Orca’s own per-agent default', () => {
    expect(laneScopedAgentLaunchSettings({ kind: 'principal' }, PEER_SETTINGS)).toEqual({
      cmdOverrides: {},
      agentDefaultArgs: undefined,
      agentDefaultEnv: undefined
    })
  })

  it('passes all three through for a shared-lane launch', () => {
    expect(laneScopedAgentLaunchSettings({ kind: 'shared' }, PEER_SETTINGS)).toEqual({
      cmdOverrides: PEER_SETTINGS.agentCmdOverrides,
      agentDefaultArgs: PEER_SETTINGS.agentDefaultArgs,
      agentDefaultEnv: PEER_SETTINGS.agentDefaultEnv
    })
  })
})
