/**
 * The closure principle at every site where the host RE-DERIVES a launch from host-wide
 * settings: a second grant's `settings.update({ agentDefaultArgs, agentDefaultEnv })` must reach
 * no lane launch, on either branch of `resolveAgentTerminalCreateOptions` and on the six other
 * builders that hand `createTerminal` a pre-baked launch (S9 §2 rows 13/14/17).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  laneScopedAgentLaunchInputs,
  laneScopedAgentLaunchSettings
} from './lane-launch-computation'
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
    getSettings: () => PEER_SETTINGS,
    // H2a (F-6d, Ruling 32 Addendum 4): createTerminal now persists the launch-token anchor
    // BEFORE spawn and aborts the launch if that persist has nowhere to land — stateless
    // no-ops, since this suite asserts launch-config closure, not anchor persistence.
    getWorkspaceSession: () => ({ terminalLaunchTokenHashesByPaneKey: {} }),
    persistTerminalLaunchTokenHash: () => {},
    forgetTerminalLaunchTokenHash: () => {},
    isWritesFrozen: () => false
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
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  })

  // The exclusion has to tell a peer's widening from the local human's narrowing: emptying the
  // record turns AgentsPane's "manual" opt-out back into Orca's YOLO default for the lane only.
  it('keeps the host’s cleared permission flag for a lane, as the shared pane does', () => {
    const settings = { agentDefaultArgs: { claude: '' }, agentDefaultEnv: { goose: {} } }

    const lane = laneScopedAgentLaunchInputs({
      lane: { kind: 'principal' },
      settings,
      agent: 'claude'
    })
    const shared = laneScopedAgentLaunchInputs({
      lane: { kind: 'shared' },
      settings,
      agent: 'claude'
    })

    expect(lane.agentArgs).toBe('')
    expect(shared.agentArgs).toBe('')
  })

  it('keeps the host’s cleared permission env for a lane, as the shared pane does', () => {
    const settings = { agentDefaultEnv: { goose: {} } }

    expect(
      laneScopedAgentLaunchInputs({ lane: { kind: 'principal' }, settings, agent: 'goose' })
        .agentEnv
    ).toEqual({})
    expect(
      laneScopedAgentLaunchInputs({ lane: { kind: 'shared' }, settings, agent: 'goose' }).agentEnv
    ).toEqual({})
  })

  it('still drops a peer’s widened args for a lane and keeps them shared', () => {
    const settings = { agentDefaultArgs: { claude: '--settings /tmp/b.json' } }

    expect(
      laneScopedAgentLaunchInputs({ lane: { kind: 'principal' }, settings, agent: 'claude' })
        .agentArgs
    ).toBe('--dangerously-skip-permissions')
    expect(
      laneScopedAgentLaunchInputs({ lane: { kind: 'shared' }, settings, agent: 'claude' }).agentArgs
    ).toBe('--settings /tmp/b.json')
  })

  it('passes all three through for a shared-lane launch', () => {
    expect(laneScopedAgentLaunchSettings({ kind: 'shared' }, PEER_SETTINGS)).toEqual({
      cmdOverrides: PEER_SETTINGS.agentCmdOverrides,
      agentDefaultArgs: PEER_SETTINGS.agentDefaultArgs,
      agentDefaultEnv: PEER_SETTINGS.agentDefaultEnv
    })
  })
})

// §2a's anchor judges `agentArgs`, `agentEnv` and `ompResumeFilePath` off the launch config the
// PANE's spawn carries, and a lane create is served here — so the host create must hand the one
// it built to `ptyController.spawn` or all three guards run over an empty object.
describe('the launch config the host create built', () => {
  it('reaches the spawn anchor, scrubbed of the client’s CLAUDE_CONFIG_DIR', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal('id:wt-1', {
      credentialLane: runtime.resolveCallerCredentialLane('device-a'),
      command: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '--model sonnet',
        agentEnv: { CLAUDE_CONFIG_DIR: '/tmp/attacker', FOO: '1' },
        ompResumeFilePath: '/repo/app/.orca/resume.jsonl'
      }
    })

    const spawned = spawn.mock.calls[0][0] as {
      launchConfig?: { agentArgs?: string; agentEnv?: Record<string, string> }
    }
    expect(spawned.launchConfig?.agentArgs).toBe('--model sonnet')
    expect(spawned.launchConfig?.agentEnv).toEqual({ FOO: '1' })
  })
})

type Internals = Record<string, unknown>
type InternalMethods = Record<string, (...args: never[]) => unknown>
type LaneArg = { kind: 'principal'; principalId: string } | { kind: 'shared' }
type BuiltStartup = { startup: { command: string; env?: Record<string, string> } }
type StartupBuilders = {
  buildStartupForAgent(
    repo: never,
    agent: string,
    prompt: string,
    lane: LaneArg
  ): BuiltStartup | null
  buildStartupForDraft(repo: never, draft: string, lane: LaneArg): Promise<BuiltStartup | null>
}

const REPO = { id: 'repo-1', path: '/repo', connectionId: null } as never

/** The mobile create/materialize pair, stubbed at the host create so the launch is observable. */
function createMobileRuntime(settings: object = PEER_SETTINGS): {
  runtime: OrcaRuntimeService
  hostCreate: ReturnType<typeof vi.fn>
} {
  const store = {
    getSettings: () => settings,
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
    const builders = runtime as unknown as StartupBuilders

    const lane = builders.buildStartupForAgent(REPO, 'claude', 'hi', {
      kind: 'principal',
      principalId: PRINCIPAL_A
    })
    const shared = builders.buildStartupForAgent(REPO, 'claude', 'hi', { kind: 'shared' })

    expect(lane?.startup.command).not.toContain('--settings')
    expect(lane?.startup.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(shared?.startup.command).toContain('--settings')
    expect(shared?.startup.env?.ANTHROPIC_API_KEY).toBe('peer-key')
  })

  // The behavioural half of the narrowing pair: the lane must not re-acquire the flag the local
  // human cleared, and the control below shows the assertion is not vacuous.
  it('carries the host’s cleared permission flag into the worktree startup builder', () => {
    const { runtime } = createMobileRuntime({ agentDefaultArgs: { claude: '' } })
    const builders = runtime as unknown as StartupBuilders

    const lane = builders.buildStartupForAgent(REPO, 'claude', 'hi', {
      kind: 'principal',
      principalId: PRINCIPAL_A
    })
    const shared = builders.buildStartupForAgent(REPO, 'claude', 'hi', { kind: 'shared' })

    expect(lane?.startup.command).not.toContain('--dangerously-skip-permissions')
    expect(shared?.startup.command).not.toContain('--dangerously-skip-permissions')
  })

  it('still gives both panes Orca’s own default when the host set nothing', () => {
    const { runtime } = createMobileRuntime({})
    const builders = runtime as unknown as StartupBuilders

    const lane = builders.buildStartupForAgent(REPO, 'claude', 'hi', {
      kind: 'principal',
      principalId: PRINCIPAL_A
    })

    expect(lane?.startup.command).toContain('--dangerously-skip-permissions')
  })

  it('reaches no lane launch through the worktree startup-draft builder', async () => {
    const { runtime } = createMobileRuntime()
    const builders = runtime as unknown as StartupBuilders

    const lane = await builders.buildStartupForDraft(REPO, 'fix the bug', {
      kind: 'principal',
      principalId: PRINCIPAL_A
    })
    const shared = await builders.buildStartupForDraft(REPO, 'fix the bug', { kind: 'shared' })

    expect(lane?.startup.command).not.toContain('--settings')
    expect(shared?.startup.command).toContain('--settings')
  })
})

// The resume and agent-session creates are structurally identical to the four above but need a
// claim signer and an execution owner to reach; this pins their wiring where it is cheap to state.
// `laneScopedAgentLaunchInputs` is the only lane-aware reader of the three host-wide launch
// settings, so a builder that resolves them itself again is a site that lost its lane. Scanned
// over all of `runtime/` rather than `orca-runtime.ts` alone: §6 pushes new logic OUT of that
// ratcheted file, so a builder extracted tomorrow would leave those two RPCs uncovered silently.
describe('the runtime resolves host-wide launch settings only through the lane-scoped helper', () => {
  // The lane-scoped computation itself, and the narrowing predicate it delegates to.
  const LANE_SCOPED_READERS = ['lane-launch-computation.ts', 'lane-permission-narrowing.ts']
  const sources = readdirSync(__dirname, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !LANE_SCOPED_READERS.includes(entry.name)
    )
    .map((entry) => join(entry.parentPath, entry.name))

  it('scans every runtime module, not just the one the builders live in today', () => {
    expect(sources).toContain(join(__dirname, 'orca-runtime.ts'))
    expect(sources.length).toBeGreaterThan(20)
  })

  // No trailing `(`: an aliased import (`resolveTuiAgentLaunchArgs as x`) still carries the name.
  it.each([
    ['resolveTuiAgentLaunchArgs'],
    ['resolveTuiAgentLaunchEnv'],
    ['cmdOverrides: settings.agentCmdOverrides']
  ])('has no direct %s left in a launch builder', (read) => {
    const offenders = sources
      .filter((file) => readFileSync(file, 'utf8').includes(read))
      .map((file) => relative(__dirname, file))

    expect(offenders).toEqual([])
  })
})
