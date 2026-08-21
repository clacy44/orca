import { describe, expect, it } from 'vitest'

import { formatCliError } from './format'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

describe('CLI error recovery', () => {
  it('prints did-you-mean next steps for an unknown-command error carrying data', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown command: worktree remov', {
      suggestions: ['worktree rm'],
      nextSteps: ['Did you mean: orca worktree rm']
    })

    const output = formatCliError(error)

    expect(output).toContain('Unknown command: worktree remov')
    expect(output).toContain('Next step: Did you mean: orca worktree rm')
  })

  it('prefers structured recovery over generic computer hints in text output', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown flag --forcce', {
      nextSteps: ['Did you mean: --force']
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Did you mean: --force')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('prefers RPC recovery over generic computer hints in text output', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_recovery',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown runtime argument',
        data: { nextSteps: ['Use the runtime-specific option'] }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Use the runtime-specific option')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('renders the dispatch_inactive fence as routable next steps', () => {
    const error = new RuntimeClientError(
      'dispatch_inactive',
      'Federated Dispatch ctx_1 is not active.',
      {
        effectsApplied: false,
        nextSteps: [
          'Reach the worker\'s terminal directly: orca terminal send --terminal term_worker --environment peer --text "<message>" --enter',
          'Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'
        ]
      }
    )

    const output = formatCliError(error)

    expect(output).toBe(
      'Federated Dispatch ctx_1 is not active.\n' +
        'Next step: Reach the worker\'s terminal directly: orca terminal send --terminal term_worker --environment peer --text "<message>" --enter\n' +
        'Next step: Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'
    )
  })

  it('renders a dispatch_inactive error from an older host exactly as today', () => {
    // Negative control: a host that predates the recovery data sends none, so the CLI
    // must print the bare message with no trailing lines.
    const error = new RuntimeClientError(
      'dispatch_inactive',
      'Federated Dispatch ctx_1 is not active.'
    )

    expect(formatCliError(error)).toBe('Federated Dispatch ctx_1 is not active.')
  })

  it('drops malformed recovery entries instead of rendering them', () => {
    // Negative control: unknown keys and non-string steps must neither throw nor leak.
    const error = new RuntimeClientError(
      'dispatch_inactive',
      'Federated Dispatch ctx_1 is not active.',
      {
        effectsApplied: false,
        workerTerminalHandle: 'term_worker',
        nextSteps: ['Start a new Dispatch.', { command: 'orca terminal send' }, 42, null]
      }
    )

    const output = formatCliError(error)

    expect(output).toBe('Federated Dispatch ctx_1 is not active.\nNext step: Start a new Dispatch.')
    expect(output).not.toContain('term_worker')
  })

  it('keeps generic computer hints when an RPC error has no recovery data', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_fallback',
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid computer argument' },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Fix the command flags or RPC params')
  })
})
