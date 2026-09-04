// S10-21a C3-v2c/C3-v2f (errata 5(p) v2.1 §C.7, T29; D-R104 (ii), Ruling 34 Addendum 15). §2.2's
// refusal promise, at the request boundary: a caller-supplied session-selecting flag in
// `agentArgs` is refused before the plan is built, on EVERY lane — unlike
// `assertLaneAgentArgsAllowed` (orca-runtime-agent-session-lane-args.test.ts), which returns
// early for a shared (non-principal) lane. All three named sites (`ensureAgentSession`,
// `createAgentSession`, `runCreateMobileSessionTerminal`) are covered here — the third by
// mocking `createTerminal` (the same trick `createRuntime()` already uses for the first two),
// which lets `runCreateMobileSessionTerminal`'s own downstream window/PTY machinery — reached
// only past the refusal check — stay unexercised rather than needing a full ready-graph harness.
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

function operationId(suffix: string): string {
  return `${Date.now()}-${suffix.padEnd(32, '0')}`
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
    handle: 'term_request_boundary',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-request-boundary',
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
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
  return { runtime, createTerminal }
}

describe('request-boundary launch-selector refusal (T29)', () => {
  it('ensureAgentSession refuses --session-id before the plan is built, on a lane-less caller', async () => {
    const { runtime, createTerminal } = createRuntime()

    const error = await runtime
      .ensureAgentSession(resumeRequest('--session-id deadbeef'))
      .catch((thrown: unknown) => thrown)

    expect((error as { reasonCode?: string }).reasonCode).toBe('launch_session_id_forbidden')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('createAgentSession refuses --fork-session before the plan is built, on a lane-less caller', async () => {
    const { runtime, createTerminal } = createRuntime()

    const error = await runtime
      .createAgentSession(createRequest(operationId('a001'), '--fork-session'))
      .catch((thrown: unknown) => thrown)

    expect((error as { reasonCode?: string }).reasonCode).toBe('launch_fork_forbidden')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('createAgentSession refuses a joined --session-id= form', async () => {
    const { runtime, createTerminal } = createRuntime()

    const error = await runtime
      .createAgentSession(createRequest(operationId('a002'), '--session-id=deadbeef'))
      .catch((thrown: unknown) => thrown)

    expect((error as { reasonCode?: string }).reasonCode).toBe('launch_session_id_forbidden')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('passes an ordinary flag through unrefused', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.createAgentSession(createRequest(operationId('a003'), '--model opus'))
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('does not refuse a non-covered agent carrying the same flag text', async () => {
    const { runtime, createTerminal } = createRuntime()
    const request = createRequest(operationId('a004'), '--session-id deadbeef')

    await expect(runtime.createAgentSession({ ...request, agent: 'codex' })).resolves.toMatchObject(
      { disposition: 'created' }
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})

// [D-R104 (ii), Ruling 34 Addendum 15] The third named site: runCreateMobileSessionTerminal's
// refusal (orca-runtime.ts, assertNoCoveredLaunchSelectorAtRequestBoundary call inside it) is
// reachable from the wire via session.tabs.createTerminal (rpc/methods/session-tabs.ts) ->
// createMobileSessionTerminal -> runCreateMobileSessionTerminal. `activate: false` keeps
// createMobileSessionTerminal's own post-create tab-navigation step (which needs a real window/
// ready-graph) out of the way — the refusal (or its absence) happens entirely inside
// runCreateMobileSessionTerminal, before that step runs.
// runCreateMobileSessionTerminal's first line, `captureReadyGraphEpoch`, requires an attached,
// synced window — reusing the pane-key-gate fixture's own `attachWindow(1)` +
// `syncWindowGraph(1, { tabs: [], leaves: [] })` shape satisfies it with no PTY/renderer harness.
function createRuntimeForMobile() {
  const built = createRuntime()
  built.runtime.attachWindow(1)
  built.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return built
}

describe('request-boundary launch-selector refusal (D-R104 (ii)): runCreateMobileSessionTerminal', () => {
  it("createMobileSessionTerminal refuses a covered agent's --session-id command before the plan is built", async () => {
    const { runtime, createTerminal } = createRuntimeForMobile()

    const error = await runtime
      .createMobileSessionTerminal('id:worktree-1', {
        credentialLane: { kind: 'shared' },
        activate: false,
        launchAgent: 'claude',
        command: 'claude --session-id X'
      })
      .catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'launch_session_id_forbidden'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it("createMobileSessionTerminal refuses a covered agent's launchConfig.agentArgs: '--fork-session'", async () => {
    const { runtime, createTerminal } = createRuntimeForMobile()

    const error = await runtime
      .createMobileSessionTerminal('id:worktree-1', {
        credentialLane: { kind: 'shared' },
        activate: false,
        launchAgent: 'claude',
        launchConfig: { agentCommand: 'claude', agentArgs: '--fork-session', agentEnv: {} }
      })
      .catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      name: 'LaunchAdmissionRefusedError',
      reasonCode: 'launch_fork_forbidden'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('does not refuse a non-covered agent (codex) carrying the same --session-id text', async () => {
    const { runtime } = createRuntimeForMobile()

    const error = await runtime
      .createMobileSessionTerminal('id:worktree-1', {
        credentialLane: { kind: 'shared' },
        activate: false,
        launchAgent: 'codex',
        command: 'codex --session-id X'
      })
      .catch((thrown: unknown) => thrown)

    // Not a LaunchAdmissionRefusedError from the request-boundary check — proves the boundary
    // itself let it through; whatever `createTerminal`'s own mock/downstream stub does past
    // that is out of this fence's scope.
    expect((error as { name?: string } | undefined)?.name).not.toBe('LaunchAdmissionRefusedError')
  })
})
