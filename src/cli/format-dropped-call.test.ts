// F-15 (Ruling 32 Addendum 2; field-run-10i): split out of format.test.ts to stay under the
// max-lines ratchet rather than growing an already near-budget file. Covers formatCliError's
// rendering of the two runtime-closed-connection codes: the unchanged absent-runtime line, and
// the new dropped-long-poll-call line (which must never carry the former).
import { describe, expect, it } from 'vitest'
import { formatCliError } from './format'
import { RuntimeClientError } from './runtime-client'

describe('formatCliError: runtime-closed-connection rendering', () => {
  it('appends "Orca is not running" for a genuinely absent runtime', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'The Orca runtime closed the connection before responding. Restart Orca and try again.'
    )

    expect(formatCliError(error)).toBe(
      'The Orca runtime closed the connection before responding. Restart Orca and try again.\n' +
        "Orca is not running. Run 'orca open' first."
    )
  })

  // A dropped long-poll call must never render the absent-runtime line — the runtime IS
  // running; it dropped the held call.
  it('renders the dropped-call line for a runtime_connection_closed error, never "Orca is not running"', () => {
    const error = new RuntimeClientError(
      'runtime_connection_closed',
      'The runtime dropped this call after 31s; the runtime is still running — re-arm it.',
      { nextSteps: ['Re-run the command.'] }
    )

    const output = formatCliError(error)

    expect(output).toContain('The runtime dropped this call after 31s')
    expect(output).toContain('re-arm it')
    expect(output).toContain('Next step: Re-run the command.')
    expect(output).not.toContain('Orca is not running')
  })
})
