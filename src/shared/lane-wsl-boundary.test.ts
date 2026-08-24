import { describe, expect, it } from 'vitest'
import { isClaudeLaneRefusal } from './claude-lane-refusals'
import { assertLaneShellSupported, assertNoLanePathCrossesWsl } from './lane-wsl-boundary'

const LANE = { principalId: '11111111-2222-4333-8444-555555555555' }
const LANE_DIR = 'C:\\Users\\dev\\AppData\\Roaming\\Orca\\claude-lanes\\11111111'

function refusalOf(run: () => void): { code: string; message: string } | 'no-refusal' {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error)
      ? { code: error.code, message: error.message }
      : { code: `not-a-lane-refusal:${String(error)}`, message: '' }
  }
  return 'no-refusal'
}

describe('assertNoLanePathCrossesWsl', () => {
  it('refuses a lane path about to cross WSLENV, whichever variable carries it', () => {
    const refusal = refusalOf(() =>
      assertNoLanePathCrossesWsl({ ORCA_SOMETHING: LANE_DIR }, 'C:\\Windows\\System32\\wsl.exe')
    )

    expect(refusal).not.toBe('no-refusal')
    expect(refusal).toMatchObject({ code: 'terminal.lane_wsl_shell_unsupported' })
  })

  // The daemon arm has no lane field, so the predicate is the directory NAME and a user's own
  // `claude-lanes` folder — on PATH, say — refuses the pane. Fail-closed on purpose, but the
  // message must name what tripped it or the refusal cannot be acted on.
  it('says the directory name is what it matched', () => {
    const refusal = refusalOf(() =>
      assertNoLanePathCrossesWsl({ PATH: '/home/dev/claude-lanes/bin:/usr/bin' }, 'wsl.exe')
    )

    expect(refusal).toMatchObject({ code: 'terminal.lane_wsl_shell_unsupported' })
    expect(refusal === 'no-refusal' ? '' : refusal.message).toContain('claude-lanes')
    expect(refusal === 'no-refusal' ? '' : refusal.message).toContain('PATH')
  })

  it('leaves a lane-free env and a non-WSL shell alone', () => {
    expect(refusalOf(() => assertNoLanePathCrossesWsl({ PATH: '/usr/bin' }, 'wsl.exe'))).toBe(
      'no-refusal'
    )
    expect(
      refusalOf(() => assertNoLanePathCrossesWsl({ CLAUDE_CONFIG_DIR: LANE_DIR }, 'bash'))
    ).toBe('no-refusal')
  })
})

describe('assertLaneShellSupported', () => {
  it('refuses a lane pane resolved to wsl.exe and allows a Windows shell', () => {
    expect(refusalOf(() => assertLaneShellSupported(LANE, 'wsl.exe'))).toMatchObject({
      code: 'terminal.lane_wsl_shell_unsupported'
    })
    expect(refusalOf(() => assertLaneShellSupported(LANE, 'powershell.exe'))).toBe('no-refusal')
    expect(refusalOf(() => assertLaneShellSupported(undefined, 'wsl.exe'))).toBe('no-refusal')
  })
})
