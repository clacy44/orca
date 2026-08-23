/**
 * A lane drops a peer's launch customization but must not drop the local human's permission
 * opt-out with it: `resolveTuiAgentLaunchArgs` reads an absent key as "use Orca's YOLO default",
 * so an emptied record re-enables the very flag the human turned off (S9 §2a item (iv), mirrored).
 */
import { describe, expect, it } from 'vitest'
import {
  laneNarrowedAgentDefaultArgs,
  laneNarrowedAgentDefaultEnv
} from './lane-permission-narrowing'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'

describe('laneNarrowedAgentDefaultArgs', () => {
  it('keeps a cleared claude arg, so a lane does not re-enable skip-permissions', () => {
    const narrowed = laneNarrowedAgentDefaultArgs({ claude: '' })

    expect(narrowed).toEqual({ claude: '' })
    expect(resolveTuiAgentLaunchArgs('claude', narrowed)).toBe('')
  })

  it('keeps a cleared codex arg', () => {
    expect(resolveTuiAgentLaunchArgs('codex', laneNarrowedAgentDefaultArgs({ codex: '  ' }))).toBe(
      ''
    )
  })

  it('keeps a strict subset of a multi-token default', () => {
    expect(laneNarrowedAgentDefaultArgs({ cline: '--auto-approve' })).toEqual({
      cline: '--auto-approve'
    })
  })

  it('drops a peer arg carrying a token Orca’s own default does not', () => {
    const narrowed = laneNarrowedAgentDefaultArgs({ claude: '--settings /tmp/peer.json' })

    expect(narrowed).toEqual({})
    expect(resolveTuiAgentLaunchArgs('claude', narrowed)).toBe('--dangerously-skip-permissions')
  })

  // The subset half, not the length half: `cline`'s default is two tokens, so a one-token peer
  // flag is shorter than it without being any part of it.
  it('drops a shorter peer arg that is no part of a multi-token default', () => {
    expect(laneNarrowedAgentDefaultArgs({ cline: '--auto-approve-everything' })).toEqual({})
  })

  it('drops a value equal to Orca’s own default rather than re-stating it', () => {
    expect(laneNarrowedAgentDefaultArgs({ claude: '--dangerously-skip-permissions' })).toEqual({})
  })

  it('drops a non-string value and an unknown agent id', () => {
    expect(
      laneNarrowedAgentDefaultArgs({ claude: 1, 'not-an-agent': '' } as unknown as Partial<
        Record<'claude', string>
      >)
    ).toEqual({})
  })

  it('returns an empty record for a missing setting', () => {
    expect(laneNarrowedAgentDefaultArgs(undefined)).toEqual({})
    expect(laneNarrowedAgentDefaultArgs(null)).toEqual({})
  })
})

describe('laneNarrowedAgentDefaultEnv', () => {
  it('keeps a cleared goose env, so a lane does not re-enable GOOSE_MODE=auto', () => {
    const narrowed = laneNarrowedAgentDefaultEnv({ goose: {} })

    expect(narrowed).toEqual({ goose: {} })
    expect(resolveTuiAgentLaunchEnv('goose', narrowed)).toEqual({})
  })

  it('drops a peer env entry Orca’s own default does not carry', () => {
    const narrowed = laneNarrowedAgentDefaultEnv({
      goose: { GOOSE_MODE: 'auto', ANTHROPIC_API_KEY: 'peer-key' }
    })

    expect(narrowed).toEqual({})
    expect(resolveTuiAgentLaunchEnv('goose', narrowed)).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('drops an env for an agent that has no default env at all', () => {
    expect(laneNarrowedAgentDefaultEnv({ claude: { ANTHROPIC_API_KEY: 'peer-key' } })).toEqual({})
  })

  it('copies the kept record rather than aliasing the caller’s', () => {
    const configured = { goose: {} }

    expect(laneNarrowedAgentDefaultEnv(configured).goose).not.toBe(configured.goose)
  })
})
