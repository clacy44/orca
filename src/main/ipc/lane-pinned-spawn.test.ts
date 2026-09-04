import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock, nodePtySpawnMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    onMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    nodePtySpawnMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue('/tmp/orca-test-userdata')
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  },
  powerMonitor: { on: vi.fn() }
}))

vi.mock('fs', () => ({
  existsSync: () => true,
  statSync: () => ({ isDirectory: () => true, mode: 0o755 }),
  accessSync: () => undefined,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('node-pty', () => ({ spawn: nodePtySpawnMock }))

// Why this module as the probe: `buildPtyHostEnv` calls it only under `agentStatusHooksEnabled`,
// so the marker below is a real observable of that flag at each of its three read sites.
vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({ ORCA_HOOKS_MARKER: 'on' }), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import {
  LocalPtyProvider,
  _resetLocalPtyProviderStateForTest
} from '../providers/local-pty-provider'
import {
  clearProviderPtyState,
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import {
  beginClaudeAuthSwitch,
  endClaudeAuthSwitch,
  hasLiveClaudePtys,
  markClaudePtyExited,
  SHARED_CLAUDE_LANE_KEY
} from '../claude-accounts/live-pty-gate'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import { makeRuntimeStubWithStore } from './runtime-stub-with-store'

const LANE_DIR = '/tmp/orca-test-userdata/claude-lanes/11111111-2222-4333-8444-555555555555'
const SHARED_DIR = '/home/dev/.claude'
const PRINCIPAL_ID = '11111111-2222-4333-8444-555555555555'
const WORKTREE_ID = 'repo::/tmp/worktree'
const TAB_ID = 'tab-lane-1'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const mainWindow = {
  isDestroyed: () => false,
  webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false }
}

let spawnedIds: string[] = []
let spawnCalls: PtySpawnOptions[] = []
let ptySeq = 0

function createProvider(daemonBacked = false) {
  return {
    ...(daemonBacked ? {} : { routesFreshSpawnsToLocalProvider: true as const }),
    spawn: vi.fn(async (options: PtySpawnOptions) => {
      spawnCalls.push(options)
      const id = `pty-lane-${(ptySeq += 1)}`
      spawnedIds.push(id)
      return { id, incarnationId: `inc-${ptySeq}` }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    providesAgentSessionOwnerListings: vi.fn(() => false),
    hasPty: vi.fn(() => false),
    attach: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  }
}

type Harness = {
  provider: ReturnType<typeof createProvider>
  prepareClaudeAuth: ReturnType<typeof vi.fn>
  controller: { spawn(args: Record<string, unknown>): Promise<unknown> }
}

function setup(
  laneOfPane: () => { kind: 'principal'; principalId: string } | null,
  options: {
    daemonBacked?: boolean
    settings?: Record<string, unknown>
    realLocal?: boolean
    /** The lane holds no credential — what §2f's wipe leaves behind until the desktop re-pushes. */
    laneUnloaded?: boolean
  } = {}
): Harness {
  handlers.clear()
  handleMock.mockReset()
  onMock.mockReset()
  const register = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    handlers.set(channel, handler)
  }
  handleMock.mockImplementation(register)
  onMock.mockImplementation(register)
  const provider = createProvider(options.daemonBacked)
  setLocalPtyProvider((options.realLocal ? new LocalPtyProvider() : provider) as never)
  const laneLoaded = options.laneUnloaded !== true
  const prepareClaudeAuth = vi.fn(async (_target: unknown, lanePrincipalId?: string) => ({
    configDir: lanePrincipalId ? LANE_DIR : SHARED_DIR,
    runtime: 'host' as const,
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch:
      lanePrincipalId && !laneLoaded
        ? {}
        : { CLAUDE_CONFIG_DIR: lanePrincipalId ? LANE_DIR : SHARED_DIR },
    stripAuthEnv: true,
    provenance: lanePrincipalId ? 'lane:label' : 'host'
  }))
  let controller: { spawn(args: Record<string, unknown>): Promise<unknown> } | undefined
  const runtime = makeRuntimeStubWithStore({
    setPtyController: vi.fn((next: never) => {
      controller = next
    }),
    credentialLaneOfPane: vi.fn(laneOfPane),
    beginPtyRegistration: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    assertPtyRegistrationAllowed: vi.fn(),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term_lane'),
    preAllocateHandleForPty: vi.fn(() => 'term_lane'),
    registerPreAllocatedHandleForPty: vi.fn(),
    registerPty: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn(),
    getDriver: () => ({ kind: 'idle' as const }),
    handleMobileUnsubscribe: vi.fn()
  })
  registerPtyHandlers(
    mainWindow as never,
    runtime as never,
    undefined,
    () => (options.settings ?? {}) as never,
    prepareClaudeAuth as never,
    undefined
  )
  return { provider, prepareClaudeAuth, controller: controller! }
}

const inLane = (): { kind: 'principal'; principalId: string } => ({
  kind: 'principal',
  principalId: PRINCIPAL_ID
})

/** The host branch — every lane create takes it, because `laneCreate` forces it (§2a). */
async function hostSpawn(
  controller: Harness['controller'],
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return await controller.spawn({
    cols: 80,
    rows: 24,
    cwd: '/tmp/worktree',
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...args
  })
}

async function rendererSpawn(args: Record<string, unknown> = {}): Promise<void> {
  await handlers.get('pty:spawn')!(null, {
    cols: 80,
    rows: 24,
    cwd: '/tmp/worktree',
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...args
  })
}

beforeEach(() => {
  spawnCalls = []
  spawnedIds = []
  nodePtySpawnMock.mockReset()
  nodePtySpawnMock.mockReturnValue({
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 4242
  })
})

afterEach(() => {
  _resetLocalPtyProviderStateForTest()
  for (const id of spawnedIds) {
    markClaudePtyExited(id)
    clearProviderPtyState(id)
  }
  vi.restoreAllMocks()
})

// S9 §2a: the lane env is command-independent, so each of these four shapes — none of which the
// Claude command regex matches — must still spawn into the lane and join its live-PTY set.
describe('a lane pane launched as a plain shell', () => {
  it.each([
    ['no command at all', {}],
    ['a plain shell command', { command: 'bash -l' }],
    ['a non-Claude agent command', { command: 'codex' }],
    ['a non-Claude startupAgent launch', { command: 'codex --yolo', launchAgent: 'codex' }]
  ])('carries the lane CLAUDE_CONFIG_DIR with %s', async (_case, args) => {
    setup(inLane)

    await rendererSpawn(args)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
    expect(spawnCalls[0]?.credentialLane).toEqual({ principalId: PRINCIPAL_ID })
    expect(hasLiveClaudePtys()).toBe(true)
  })
})

// S9 §2f/§5 S9c: a push into lane A holds lane A's gate. It refuses lane A's spawns — a plain
// shell too, because a lane pane carries lane credentials whatever it runs — and nothing else.
// S9 §2a consequence 2 / §5 S9c: after the close-wipe the lane holds no credential, and EVERY
// lane pane fails closed — a plain shell too, because it carries the lane's credentials as well.
describe('a launch into a lane the wipe emptied', () => {
  it.each([
    ['a claude command', { command: 'claude' }],
    ['a plain shell', { command: 'bash -l' }],
    ['no command at all', {}]
  ])('fails closed for %s', async (_case, args) => {
    setup(inLane, { laneUnloaded: true })

    await expect(rendererSpawn(args)).rejects.toThrow(/not loaded on this host/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('leaves a shared-lane pane launching', async () => {
    setup(() => null, { laneUnloaded: true })

    await rendererSpawn({ command: 'claude' })

    expect(spawnCalls).toHaveLength(1)
  })
})

describe('the per-lane account switch gate', () => {
  const OTHER_PRINCIPAL_ID = '99999999-8888-4777-8666-555555555555'

  afterEach(() => {
    endClaudeAuthSwitch(PRINCIPAL_ID)
    endClaudeAuthSwitch(OTHER_PRINCIPAL_ID)
    endClaudeAuthSwitch(SHARED_CLAUDE_LANE_KEY)
  })

  it.each([
    ['a claude command', { command: 'claude' }],
    ['a plain shell', { command: 'bash -l' }]
  ])('refuses %s spawning in the lane being pushed to', async (_case, args) => {
    setup(inLane)
    beginClaudeAuthSwitch(PRINCIPAL_ID)

    await expect(rendererSpawn(args)).rejects.toThrow('account switch is in progress')
    expect(spawnCalls).toHaveLength(0)
  })

  it("leaves another principal's lane spawning during that push", async () => {
    setup(() => ({ kind: 'principal', principalId: OTHER_PRINCIPAL_ID }))
    beginClaudeAuthSwitch(PRINCIPAL_ID)

    await rendererSpawn({ command: 'claude' })

    expect(spawnCalls).toHaveLength(1)
  })

  it('leaves a shared-lane claude spawning during a lane push', async () => {
    setup(() => null)
    beginClaudeAuthSwitch(PRINCIPAL_ID)

    await rendererSpawn({ command: 'claude' })

    expect(spawnCalls).toHaveLength(1)
  })

  it('still refuses a shared-lane claude during the HOST switch', async () => {
    setup(() => null)
    beginClaudeAuthSwitch(SHARED_CLAUDE_LANE_KEY)

    await expect(rendererSpawn({ command: 'claude' })).rejects.toThrow(
      'account switch is in progress'
    )
  })
})

describe('lane resolution at the spawn anchor', () => {
  it('leaves an SSH pane without a lane path and keeps its own config dir', async () => {
    const { prepareClaudeAuth, provider } = setup(inLane)
    registerSshPtyProvider('ssh-1', provider as never)
    try {
      await rendererSpawn({
        connectionId: 'ssh-1',
        env: { CLAUDE_CONFIG_DIR: '/remote/home/.claude' }
      })
    } finally {
      unregisterSshPtyProvider('ssh-1')
    }

    expect(prepareClaudeAuth).not.toHaveBeenCalled()
    expect(spawnCalls[0]?.env?.CLAUDE_CONFIG_DIR).toBe('/remote/home/.claude')
    expect(spawnCalls[0]?.credentialLane).toBeUndefined()
  })

  it('refuses an OpenClaude launch into a lane', async () => {
    setup(inLane)

    await expect(rendererSpawn({ command: 'openclaude' })).rejects.toThrow(/OpenClaude/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('leaves a shared-lane pane on the host preparation', async () => {
    setup(() => null)

    await rendererSpawn({ command: 'claude' })

    expect(spawnCalls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(SHARED_DIR)
    expect(spawnCalls[0]?.credentialLane).toBeUndefined()
  })

  it('gives the agent-session-ensure spawn the lane env, on the wrapper alone', async () => {
    const { controller } = setup(inLane)
    const claim = {
      digestVersion: 1 as const,
      keyId: 'claim-key',
      identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'codex' as const
    }

    await controller
      .spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp/worktree',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        agentSessionEnsure: {
          claim,
          surface: { worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_ID }
        }
      })
      .catch(() => undefined)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
    // Why the stamp and not just the config dir: path A merges the auth patch into `env` well
    // before the anchor, so only the wrapper's own output proves this edge ran through it.
    expect(spawnCalls[0]?.credentialLane).toEqual({ principalId: PRINCIPAL_ID })
  })
})

// Row 16, asserted once per provider mode: the third read is inside the provider's own env build,
// where a host-wide `agentStatusHooksEnabled: false` used to strip another principal's lane hooks.
describe('a peer turning agent status hooks off host-wide', () => {
  it('still leaves the hook env on a lane spawn in daemon mode', async () => {
    setup(inLane, { daemonBacked: true, settings: { agentStatusHooksEnabled: false } })

    await rendererSpawn({})

    expect(spawnCalls[0]?.env?.ORCA_HOOKS_MARKER).toBe('on')
  })

  it('strips it from a shared-lane spawn in daemon mode', async () => {
    setup(() => null, { daemonBacked: true, settings: { agentStatusHooksEnabled: false } })

    await rendererSpawn({})

    expect(spawnCalls[0]?.env?.ORCA_HOOKS_MARKER).toBeUndefined()
  })

  it('still leaves the hook env on a lane spawn in LocalPtyProvider mode', async () => {
    setup(inLane, { realLocal: true, settings: { agentStatusHooksEnabled: false } })

    await rendererSpawn({})

    expect(nodePtySpawnMock.mock.calls.at(-1)?.[2].env.ORCA_HOOKS_MARKER).toBe('on')
    expect(nodePtySpawnMock.mock.calls.at(-1)?.[2].env.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
  })

  it('strips it from a shared-lane spawn in LocalPtyProvider mode', async () => {
    setup(() => null, { realLocal: true, settings: { agentStatusHooksEnabled: false } })

    await rendererSpawn({})

    expect(nodePtySpawnMock.mock.calls.at(-1)?.[2].env.ORCA_HOOKS_MARKER).toBeUndefined()
  })
})

// §2a routes every lane create through the HOST branch (`shouldCreateInBackground` includes
// `laneCreate`), so guard 2 and the resume containment are only real if the launch config the
// runtime built reaches this edge — the renderer edge is the one a lane create never takes.
describe('the launch config on the host spawn path', () => {
  it('refuses a settings-redirecting agentArgs', async () => {
    const { controller } = setup(inLane)

    await expect(
      hostSpawn(controller, { launchConfig: { agentArgs: '--settings /tmp/attacker.json' } })
    ).rejects.toThrow(/settings/i)
    expect(spawnCalls).toHaveLength(0)
  })

  it('refuses an auth env var defined in launchConfig.agentEnv', async () => {
    const { controller } = setup(inLane)

    await expect(
      hostSpawn(controller, { launchConfig: { agentEnv: { ANTHROPIC_API_KEY: 'attacker' } } })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('refuses an ompResumeFilePath outside the lane and the workspace', async () => {
    const { controller } = setup(inLane)

    await expect(
      hostSpawn(controller, {
        launchConfig: { ompResumeFilePath: '/tmp/other-lane/sessions/resume.jsonl' }
      })
    ).rejects.toThrow(/outside your personal Claude credential lane[\s\S]*shared-lane pane/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('leaves the same launch config alone on a shared-lane pane', async () => {
    const { controller } = setup(() => null)

    await hostSpawn(controller, {
      launchConfig: {
        agentArgs: '--settings /tmp/attacker.json',
        ompResumeFilePath: '/tmp/other-lane/sessions/resume.jsonl'
      }
    })

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.credentialLane).toBeUndefined()
  })
})
