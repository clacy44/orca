import { describe, expect, it, vi } from 'vitest'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

// Row 8 at the two agent-session RPCs: `request.agentArgs` is baked into the launch COMMAND by
// the startup-plan builder, which the spawn anchor never parses.

const LANE_DEVICE = 'device-with-lane'
const LANE_LESS_DEVICE = 'device-without-lane'
const REDIRECTING_ARGS = '--settings /tmp/attacker-settings.json'
const MODEL_ARGS = '--model opus'

function operationId(suffix: string): string {
  return `${Date.now()}-${suffix.padEnd(32, '0')}`
}

/** Quoting is platform-shaped; the flags are what this guard is about. */
function unquoted(command: string | undefined): string {
  return (command ?? '').replace(/["']/g, '')
}

function createRequest(
  clientOperationId: string,
  agentArgs: string
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'claude',
    prompt: 'do the thing',
    agentArgs,
    presentation: 'background'
  }
}

function resumeRequest(agentArgs: string) {
  return {
    kind: 'explicit' as const,
    worktree: 'id:worktree-1',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'provider-session-1' },
    agentArgs
  }
}

function terminal() {
  return {
    handle: 'term_lane_args',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-lane-args',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime() {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    {
      getLocalProvider: () =>
        ({
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true
        }) as never
    }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  runtime.setPrincipalLaneLookup({
    principalOf: (deviceId) => (deviceId === LANE_DEVICE ? 'principal-1' : null),
    linkPrincipalOf: () => null
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
  return { runtime, createTerminal }
}

function expectArgsRefusal(error: unknown): void {
  expect(isClaudeLaneRefusal(error)).toBe(true)
  const refusal = error as { code: string; message: string }
  expect(refusal.code).toBe('terminal.agent_args_refused')
  expect(refusal.message).toContain('--settings')
  expect(refusal.message).toContain('credential lane.')
}

describe('terminal.createAgentSession lane agent args', () => {
  it('refuses a settings-redirecting flag from a lane caller before the plan is built', async () => {
    const { runtime, createTerminal } = createRuntime()

    const error = await runtime
      .createAgentSession(createRequest(operationId('a1'), REDIRECTING_ARGS), {
        pairedDeviceId: LANE_DEVICE
      })
      .catch((thrown: unknown) => thrown)

    expectArgsRefusal(error)
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('passes a model flag from a lane caller through to the launch command', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.createAgentSession(createRequest(operationId('b2'), MODEL_ARGS), {
        pairedDeviceId: LANE_DEVICE
      })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(unquoted(createTerminal.mock.calls[0]?.[1]?.command)).toContain(MODEL_ARGS)
    expect(createTerminal.mock.calls[0]?.[1]?.credentialLane).toEqual({
      kind: 'principal',
      principalId: 'principal-1'
    })
  })

  it('leaves a lane-less caller unchanged', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.createAgentSession(createRequest(operationId('c3'), REDIRECTING_ARGS), {
        pairedDeviceId: LANE_LESS_DEVICE
      })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(unquoted(createTerminal.mock.calls[0]?.[1]?.command)).toContain(REDIRECTING_ARGS)
    expect(createTerminal.mock.calls[0]?.[1]?.credentialLane).toEqual({ kind: 'shared' })
  })
})

describe('terminal.ensureAgentSession lane agent args', () => {
  it('refuses a settings-redirecting flag from a lane caller before the plan is built', async () => {
    const { runtime, createTerminal } = createRuntime()

    const error = await runtime
      .ensureAgentSession(resumeRequest(REDIRECTING_ARGS), { pairedDeviceId: LANE_DEVICE })
      .catch((thrown: unknown) => thrown)

    expectArgsRefusal(error)
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('passes a model flag from a lane caller through to the launch command', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.ensureAgentSession(resumeRequest(MODEL_ARGS), { pairedDeviceId: LANE_DEVICE })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(unquoted(createTerminal.mock.calls[0]?.[1]?.command)).toContain(MODEL_ARGS)
    expect(createTerminal.mock.calls[0]?.[1]?.credentialLane).toEqual({
      kind: 'principal',
      principalId: 'principal-1'
    })
  })

  it('leaves a lane-less caller unchanged', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.ensureAgentSession(resumeRequest(REDIRECTING_ARGS), {
        pairedDeviceId: LANE_LESS_DEVICE
      })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(unquoted(createTerminal.mock.calls[0]?.[1]?.command)).toContain(REDIRECTING_ARGS)
    expect(createTerminal.mock.calls[0]?.[1]?.credentialLane).toEqual({ kind: 'shared' })
  })
})
