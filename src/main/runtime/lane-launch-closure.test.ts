/**
 * The closure principle at every site where the host RE-DERIVES a launch from host-wide
 * settings: a second grant's `settings.update({ agentDefaultArgs, agentDefaultEnv })` must reach
 * no lane launch, on either branch of `resolveAgentTerminalCreateOptions` and on the six other
 * builders that hand `createTerminal` a pre-baked launch (S9 §2 rows 13/14/17).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

type Internals = Record<string, unknown>
type InternalMethods = Record<string, (...args: never[]) => unknown>

const REPO = { id: 'repo-1', path: '/repo', connectionId: null } as never

/** The mobile create/materialize pair, stubbed at the host create so the launch is observable. */
function createMobileRuntime(): {
  runtime: OrcaRuntimeService
  hostCreate: ReturnType<typeof vi.fn>
} {
  const store = {
    getSettings: () => PEER_SETTINGS,
    getRepo: () => undefined
  } as unknown as ConstructorParameters<typeof OrcaRuntimeService>[0]
  const runtime = new OrcaRuntimeService(store)
  runtime.setPrincipalLaneLookup(principals)
  const spyInternal = (name: string) => vi.spyOn(runtime as unknown as InternalMethods, name)
  spyInternal('resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path: '/repo/app',
    connectionId: null,
    repo: REPO,
    folderWorkspace: null
  } as never)
  spyInternal('hydrateHeadlessMobileSessionTabsFromWorkspaceSession').mockReturnValue(
    undefined as never
  )
  spyInternal('captureReadyGraphEpoch').mockReturnValue(1 as never)
  spyInternal('assertStableReadyGraph').mockReturnValue(undefined as never)
  spyInternal('markLocalWorkspaceTrustedForAgent').mockReturnValue(undefined as never)
  spyInternal('getAvailableAuthoritativeWindow').mockReturnValue(null as never)
  const hostCreate = vi.fn().mockResolvedValue({ tab: { id: 't', parentTabId: 't' }, tabs: [] })
  ;(runtime as unknown as Internals).createRuntimeOwnedMobileSessionTerminal = hostCreate
  return { runtime, hostCreate }
}

describe('a peer’s host-wide launch settings against the builders that bypass the resolver', () => {
  it('reaches no lane launch through session.tabs.createTerminal with an agent', async () => {
    const { runtime, hostCreate } = createMobileRuntime()

    await runtime.createMobileSessionTerminal('id:wt-1', {
      credentialLane: runtime.resolveCallerCredentialLane('device-a'),
      agent: 'claude'
    })

    const opts = hostCreate.mock.calls[0][3] as { command?: string; env?: Record<string, string> }
    expect(opts.command).not.toContain('--settings')
    expect(opts.command).not.toContain('claude-from-a-peer')
    expect(opts.env?.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('still shapes a shared-lane session.tabs.createTerminal', async () => {
    const { runtime, hostCreate } = createMobileRuntime()

    await runtime.createMobileSessionTerminal('id:wt-1', {
      credentialLane: { kind: 'shared' },
      agent: 'claude'
    })

    const opts = hostCreate.mock.calls[0][3] as { command?: string; env?: Record<string, string> }
    expect(opts.command).toContain('--settings')
    expect(opts.env?.ANTHROPIC_API_KEY).toBe('peer-key')
  })

  it('reaches no lane launch through the worktree startup builder', () => {
    const { runtime } = createMobileRuntime()
    const build = (runtime as unknown as InternalMethods).buildStartupForAgent.bind(runtime)

    const laneStartup = build(REPO, 'claude', 'hi', { kind: 'principal', principalId: PRINCIPAL_A })
    const sharedStartup = build(REPO, 'claude', 'hi', { kind: 'shared' })

    const lane = laneStartup as { startup: { command: string; env?: Record<string, string> } }
    const shared = sharedStartup as { startup: { command: string; env?: Record<string, string> } }
    expect(lane.startup.command).not.toContain('--settings')
    expect(lane.startup.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(shared.startup.command).toContain('--settings')
    expect(shared.startup.env?.ANTHROPIC_API_KEY).toBe('peer-key')
  })

  it('reaches no lane launch through the worktree startup-draft builder', async () => {
    const { runtime } = createMobileRuntime()
    const build = (runtime as unknown as InternalMethods).buildStartupForDraft.bind(runtime)

    const laneDraft = (await build(REPO, 'fix the bug', {
      kind: 'principal',
      principalId: PRINCIPAL_A
    })) as { startup: { command: string } } | null
    const sharedDraft = (await build(REPO, 'fix the bug', { kind: 'shared' })) as {
      startup: { command: string }
    } | null

    expect(laneDraft?.startup.command).not.toContain('--settings')
    expect(sharedDraft?.startup.command).toContain('--settings')
  })
})

// The resume and agent-session creates are structurally identical to the four above but need a
// claim signer and an execution owner to reach; this pins their wiring where it is cheap to state.
// `laneScopedAgentLaunchInputs` is the only lane-aware reader of the three host-wide launch
// settings, so a builder that resolves them itself again is a site that lost its lane.
describe('the runtime resolves host-wide launch settings only through the lane-scoped helper', () => {
  const source = readFileSync(join(__dirname, 'orca-runtime.ts'), 'utf8')

  it.each([
    ['resolveTuiAgentLaunchArgs('],
    ['resolveTuiAgentLaunchEnv('],
    ['cmdOverrides: settings.agentCmdOverrides']
  ])('has no direct %s left in a launch builder', (read) => {
    expect(source).not.toContain(read)
  })
})
