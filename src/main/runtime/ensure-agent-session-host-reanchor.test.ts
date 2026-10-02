// D-30a / Ruling 36 (train 10z.9, arm H): `ensureAgentSession`'s host-only `internal.hostReanchor`
// appends the shared re-anchor prompt to the claude HOST_RESUME launch command, and nowhere else.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { DAEMON_DEATH_REANCHOR_PROMPT } from '../../shared/daemon-death-reanchor-prompt'
import { quoteStartupArg, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { _resetRestoreSweepLockForTest } from './restore-sweep-lock'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const HOST_ID = 'local'
const SESSION = '11111111-2222-4333-8444-555555555555'

type SpawnOpts = { command?: string; launchConfig?: unknown }
type EnsureInternal = Parameters<OrcaRuntimeService['ensureAgentSession']>[2]

describe('D-30a arm H: ensureAgentSession hostReanchor', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    _resetRestoreSweepLockForTest()
    vi.restoreAllMocks()
  })

  async function launchCommand(opts: {
    agent?: 'claude' | 'codex'
    platform?: NodeJS.Platform
    windowsShell?: string
    cmdOverrides?: Record<string, string>
    flag?: boolean
    provenance?: 'host-restore' | 'none'
  }): Promise<{ command: string; launchConfig: unknown }> {
    const agent = opts.agent ?? 'claude'
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: opts.cmdOverrides ?? {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        terminalWindowsShell: opts.windowsShell
      })
    } as never)
    runtime.setOrchestrationDb(db)
    const internals = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
      getAgentLaunchPlatformForWorkspace: (scope: unknown) => NodeJS.Platform
    }
    vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'wt-1',
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    if (opts.platform) {
      vi.spyOn(internals, 'getAgentLaunchPlatformForWorkspace').mockReturnValue(opts.platform)
    }
    const calls: SpawnOpts[] = []
    runtime.setPtyController({
      spawn: async (spawnOpts: SpawnOpts) => {
        calls.push(spawnOpts)
        return { id: randomUUID(), isReattach: false }
      },
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    } as never)

    const paneKey = `tab-old:${randomUUID()}`
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'chair-reanchor',
      role: null,
      hostId: HOST_ID,
      paneKey,
      terminalHandle: 'term_old',
      processIncarnation: 'inc-old',
      worktreeId: 'wt-1',
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_old',
      originHostId: HOST_ID
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const launched = db.recordLaunch({
      hostId: HOST_ID,
      paneKey,
      agentType: agent,
      sessionId: SESSION,
      launchGeneration: 'gen-prior',
      executionHostId: 'local',
      evidence: 'host_launch'
    })
    if (!launched.ok) {
      throw new Error('fixture launch row failed')
    }
    const ticket = runtime.mintRestoreTicket({
      predecessorPaneKey: paneKey,
      sessionId: SESSION,
      executionHostId: 'local',
      launchGeneration: runtime.getLaunchGenerationId(),
      launchSeq: launched.row.seq
    })
    const internal = {
      restoreProvenance:
        opts.provenance === 'none'
          ? { kind: 'none' as const }
          : { kind: 'host-restore' as const, ticket },
      ...(opts.flag === false ? {} : { hostReanchor: true as const })
    } as EnsureInternal
    await runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: 'id:wt-1',
        agent,
        providerSession: { key: 'session_id', id: SESSION },
        presentation: 'background',
        launchPreferences: { model: 'claude-opus-4-8', effort: 'max' }
      },
      {},
      internal
    )
    expect(calls).toHaveLength(1)
    return { command: calls[0]!.command as string, launchConfig: calls[0]!.launchConfig }
  }

  function quoted(shell: AgentStartupShell): string {
    return quoteStartupArg(DAEMON_DEATH_REANCHOR_PROMPT, shell)
  }

  it('(a) host-restore + flag + claude: the prefs, then --resume X, then the quoted prompt last', async () => {
    const { command, launchConfig } = await launchCommand({})
    expect(command.endsWith(`'--resume' '${SESSION}' ${quoted('posix')}`)).toBe(true)
    expect(command.indexOf("'--effort'")).toBeLessThan(command.indexOf("'--resume'"))
    expect(command.split(DAEMON_DEATH_REANCHOR_PROMPT)).toHaveLength(2)
    expect(JSON.stringify(launchConfig ?? null)).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
  })

  it('(a2) the same on a Windows host under PowerShell and cmd quoting', async () => {
    for (const [windowsShell, shell] of [
      ['powershell.exe', 'powershell'],
      ['cmd.exe', 'cmd']
    ] as const) {
      const { command, launchConfig } = await launchCommand({ platform: 'win32', windowsShell })
      expect(command.endsWith(` ${quoted(shell)}`)).toBe(true)
      expect(JSON.stringify(launchConfig ?? null)).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
    }
  })

  it('(b) the flag with provenance none: no prompt', async () => {
    const { command } = await launchCommand({ provenance: 'none' })
    expect(command).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
  })

  it('(c) the flag for a non-claude agent: no prompt', async () => {
    const { command } = await launchCommand({ agent: 'codex' })
    expect(command).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
  })

  it('(d) a wrapper agent command: no prompt', async () => {
    const { command } = await launchCommand({ cmdOverrides: { claude: 'bash -c claude' } })
    expect(command).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
  })

  it('(e) without the flag the command is the pre-change command, byte for byte', async () => {
    const withFlag = await launchCommand({})
    const without = await launchCommand({ flag: false })
    expect(without.command).not.toContain(DAEMON_DEATH_REANCHOR_PROMPT)
    expect(withFlag.command).toBe(`${without.command} ${quoted('posix')}`)
    expect(without.launchConfig).toEqual(withFlag.launchConfig)
  })
})
