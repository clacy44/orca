import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
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

vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    process: 'zsh',
    pid: 12345
  })
}))

vi.mock('../opencode/hook-service', () => ({
  openCodeHookService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

vi.mock('../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), clearPty: vi.fn() }
}))

import {
  clearProviderPtyState,
  registerPtyHandlers,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import { hasLiveClaudePtys, markClaudePtyExited } from '../claude-accounts/live-pty-gate'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

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

function createProvider() {
  return {
    routesFreshSpawnsToLocalProvider: true as const,
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

function setup(laneOfPane: () => { kind: 'principal'; principalId: string } | null): Harness {
  handlers.clear()
  handleMock.mockReset()
  onMock.mockReset()
  const register = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    handlers.set(channel, handler)
  }
  handleMock.mockImplementation(register)
  onMock.mockImplementation(register)
  const provider = createProvider()
  setLocalPtyProvider(provider as never)
  const prepareClaudeAuth = vi.fn(async (_target: unknown, lanePrincipalId?: string) => ({
    configDir: lanePrincipalId ? LANE_DIR : SHARED_DIR,
    runtime: 'host' as const,
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: lanePrincipalId ? LANE_DIR : SHARED_DIR },
    stripAuthEnv: true,
    provenance: lanePrincipalId ? 'lane:label' : 'host'
  }))
  let controller: { spawn(args: Record<string, unknown>): Promise<unknown> } | undefined
  const runtime = {
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
  }
  registerPtyHandlers(
    mainWindow as never,
    runtime as never,
    undefined,
    () => ({}) as never,
    prepareClaudeAuth as never,
    undefined
  )
  return { provider, prepareClaudeAuth, controller: controller! }
}

const inLane = (): { kind: 'principal'; principalId: string } => ({
  kind: 'principal',
  principalId: PRINCIPAL_ID
})

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
})

afterEach(() => {
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
