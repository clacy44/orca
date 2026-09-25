import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

// G1 L2 (S10-22a): `request.appendAgentArgs` appends after the host-default `agentArgs`
// instead of replacing them, so chair restore/succession launches layer manifest
// `launchArgs` onto host defaults rather than clobbering them. Ordinary `agentArgs` still
// replaces, unaffected by this field's presence when unset.

const HOST_DEFAULT_ARGS = 'X'
const LAUNCH_ARGS = '--autocompact 200000'

function operationId(suffix: string): string {
  return `${Date.now()}-${suffix.padEnd(32, '0')}`
}

function unquoted(command: string | undefined): string {
  return (command ?? '').replace(/["']/g, '')
}

function terminal() {
  return {
    handle: 'term_append_args',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-append-args',
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
        agentDefaultArgs: { claude: HOST_DEFAULT_ARGS },
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

describe('appendAgentArgs layers manifest launchArgs onto host defaults', () => {
  it('createAgentSession: appends after the host default args instead of replacing them', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.createAgentSession({
        clientOperationId: operationId('a1'),
        worktree: 'id:worktree-1',
        agent: 'claude',
        prompt: 'do the thing',
        appendAgentArgs: LAUNCH_ARGS,
        presentation: 'background'
      })
    ).resolves.toMatchObject({ disposition: 'created' })

    const command = unquoted(createTerminal.mock.calls[0]?.[1]?.command)
    expect(command).toContain(`${HOST_DEFAULT_ARGS} --autocompact 200000`)
  })

  it('ensureAgentSession: appends after the host default args instead of replacing them', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'provider-session-1' },
        appendAgentArgs: LAUNCH_ARGS
      })
    ).resolves.toMatchObject({ disposition: 'created' })

    const command = unquoted(createTerminal.mock.calls[0]?.[1]?.command)
    expect(command).toContain(`${HOST_DEFAULT_ARGS} --autocompact 200000`)
  })

  it('createAgentSession: an ordinary agentArgs override still replaces host defaults', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.createAgentSession({
        clientOperationId: operationId('b2'),
        worktree: 'id:worktree-1',
        agent: 'claude',
        prompt: 'do the thing',
        agentArgs: '--model opus',
        presentation: 'background'
      })
    ).resolves.toMatchObject({ disposition: 'created' })

    const command = unquoted(createTerminal.mock.calls[0]?.[1]?.command)
    expect(command).toContain('--model opus')
    expect(command).not.toContain(HOST_DEFAULT_ARGS)
  })
})
