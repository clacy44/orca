import { describe, expect, it, vi } from 'vitest'

import { HANDLER_COMMAND_KEYS } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import { formatTerminalAgentStatus } from '../terminal-format'
import { RuntimeClientError } from '../runtime/types'
import { TERMINAL_HANDLERS } from './terminal'

const AGENT_STATUS_COMMAND = 'terminal agent-status'

function runAgentStatus(
  call: ReturnType<typeof vi.fn>,
  flags: [string, string | boolean][] = [['terminal', 'term_worker']]
): Promise<void> {
  return TERMINAL_HANDLERS[AGENT_STATUS_COMMAND]({
    flags: new Map<string, string | boolean>(flags),
    client: { call },
    cwd: '/tmp/repo',
    json: false
  } as never)
}

describe('terminal agent-status spec parity', () => {
  const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === AGENT_STATUS_COMMAND)

  it('declares a spec that the dispatch table can reach', () => {
    expect(spec).toBeDefined()
    expect(HANDLER_COMMAND_KEYS.has(AGENT_STATUS_COMMAND)).toBe(true)
    expect(TERMINAL_HANDLERS[AGENT_STATUS_COMMAND]).toBeTypeOf('function')
  })

  it('allows the handle and peer-routing flags the usage advertises', () => {
    expect(spec?.allowedFlags).toEqual(expect.arrayContaining(['terminal', 'environment', 'json']))
    expect(spec?.usage).toBe(
      'orca terminal agent-status --terminal <handle> [--environment <peer>] [--json]'
    )
  })
})

describe('terminal agent-status handler', () => {
  it('asks the shipping RPC for the named terminal', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { agentStatus: { handle: 'term_worker', isRunningAgent: true, status: 'permission' } }
    })

    await runAgentStatus(call)

    expect(call).toHaveBeenCalledWith('terminal.agentStatus', { terminal: 'term_worker' })
  })

  it('requires --terminal rather than guessing an active pane', async () => {
    const call = vi.fn()

    await expect(runAgentStatus(call, [])).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('renders an older host method_not_found as a compatibility message', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(
        new RuntimeClientError('method_not_found', 'Unknown method: terminal.agentStatus')
      )

    await expect(runAgentStatus(call)).rejects.toMatchObject({
      code: 'capability_unsupported',
      message:
        'The connected Orca runtime does not support terminal agent-status. Update or restart Orca and try again.'
    })
  })

  it('passes any other runtime failure through untouched', async () => {
    const call = vi
      .fn()
      .mockRejectedValue(new RuntimeClientError('terminal_gone', 'Terminal term_worker is gone.'))

    await expect(runAgentStatus(call)).rejects.toMatchObject({ code: 'terminal_gone' })
  })
})

describe('formatTerminalAgentStatus', () => {
  it('reports the gate verdict', () => {
    expect(
      formatTerminalAgentStatus({
        agentStatus: { handle: 'term_worker', isRunningAgent: true, status: 'permission' }
      })
    ).toBe('handle: term_worker\nisRunningAgent: true\nstatus: permission')
  })

  it('renders a null status as unknown, never as a verdict', () => {
    expect(
      formatTerminalAgentStatus({
        agentStatus: { handle: 'term_shell', isRunningAgent: false, status: null }
      })
    ).toBe('handle: term_shell\nisRunningAgent: false\nstatus: unknown')
  })
})
