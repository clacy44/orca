import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { ENVIRONMENT_HANDLERS } from './environment'
import { ENVIRONMENT_COMMAND_SPECS } from '../specs/environment'
import type { RuntimeTerminalPresence } from '../../shared/runtime-types'
import type * as EnvironmentStore from '../runtime/environments'

// Why mocked: the roster polls every SAVED environment, so without this the suite would read the
// developer's own environment store and open real sockets to whatever peers it finds.
vi.mock('../runtime/environments', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvironmentStore>()),
  listEnvironments: () => []
}))

function rosterSpec(): (typeof ENVIRONMENT_COMMAND_SPECS)[number] {
  const spec = ENVIRONMENT_COMMAND_SPECS.find(
    (entry) => entry.path.join(' ') === 'environment roster'
  )
  if (!spec) {
    throw new Error('Missing environment roster spec')
  }
  return spec
}

function terminalRow(handle: string, presence?: RuntimeTerminalPresence): Record<string, unknown> {
  return {
    handle,
    title: null,
    worktreePath: '/repo/a',
    ...(presence ? { presence } : {})
  }
}

async function runRoster(
  terminals: Record<string, unknown>[],
  json: boolean
): Promise<{ call: ReturnType<typeof vi.fn>; output: string }> {
  const call = vi.fn().mockResolvedValue({
    _meta: { runtimeId: 'runtime_local' },
    result: { terminals, truncated: false }
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await ENVIRONMENT_HANDLERS['environment roster']!({
    flags: new Map(),
    client: { call } as unknown as RuntimeClient,
    cwd: '/tmp/worktree',
    json
  })
  return { call, output: log.mock.calls.map((entry) => String(entry[0])).join('\n') }
}

describe('environment roster presence column', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks every polled runtime for presence', async () => {
    const { call } = await runRoster([terminalRow('term_a')], true)

    expect(call).toHaveBeenCalledWith('terminal.list', {
      limit: undefined,
      includeVisualLayouts: false,
      includePresence: true
    })
  })

  it('prints presence? for a peer that answered without the key', async () => {
    const { output } = await runRoster([terminalRow('term_a')], false)

    expect(output).toContain('term_a')
    expect(output).toContain('presence?')
  })

  it('prints - for a capable peer with nobody attached and the names when somebody is', async () => {
    const { output } = await runRoster(
      [
        terminalRow('term_idle', { attachedCount: 0, participants: [] }),
        terminalRow('term_busy', {
          attachedCount: 2,
          participants: [
            { participantId: 'p-1', label: 'Ana', typing: true, writing: false },
            { participantId: 'host', label: 'devbox', typing: false, writing: true }
          ]
        })
      ],
      false
    )

    const columnOf = (handle: string): string | undefined =>
      output
        .split('\n')
        .find((line) => line.includes(handle))
        ?.split('  ')
        .at(-1)
    expect(columnOf('term_idle')).toBe('-')
    expect(columnOf('term_busy')).toBe('Ana (typing), devbox (writing)')
  })

  // Why a parity test and not a doc read: the notes are the only description of this column a user gets,
  // so a formatter that stops printing one of these states must fail here rather than drift silently.
  it('documents every state the formatter can print', async () => {
    const notes = (rosterSpec().notes ?? []).join(' ')
    const { output } = await runRoster(
      [
        terminalRow('term_old'),
        terminalRow('term_idle', { attachedCount: 0, participants: [] }),
        terminalRow('term_busy', {
          attachedCount: 1,
          participants: [{ participantId: 'p-1', label: 'Ana', typing: true, writing: false }]
        })
      ],
      false
    )

    expect(notes).toContain('presence')
    for (const state of ['presence?', '"-"', '(typing)', '(writing)']) {
      expect(notes).toContain(state)
    }
    for (const printed of ['presence?', 'Ana (typing)']) {
      expect(output).toContain(printed)
    }
  })
})
