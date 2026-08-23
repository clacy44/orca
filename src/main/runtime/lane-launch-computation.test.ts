import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  computeLaneLaunch,
  type LaneLaunchSpawnShape,
  type PaneLaneLaunch
} from './lane-launch-computation'

const LANE_DIR = '/lanes/p1'
const PATCH = { CLAUDE_CONFIG_DIR: LANE_DIR }

function laneOf(overrides: Partial<Extract<PaneLaneLaunch, { kind: 'principal' }>> = {}) {
  return {
    kind: 'principal' as const,
    principalId: '11111111-2222-4333-8444-555555555555',
    envPatch: PATCH,
    containmentRoots: [LANE_DIR],
    platform: 'linux' as NodeJS.Platform,
    ...overrides
  }
}

/** Widens an object literal so the generic infers the contract shape, not the literal's keys. */
function spawn(options: LaneLaunchSpawnShape): LaneLaunchSpawnShape {
  return options
}

function refusalCodeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `not-a-lane-refusal:${String(error)}`
  }
  return 'no-refusal'
}

describe('computeLaneLaunch', () => {
  it('writes the lane env patch last, over a client CLAUDE_CONFIG_DIR', () => {
    const result = computeLaneLaunch(
      laneOf(),
      spawn({ env: { CLAUDE_CONFIG_DIR: '/tmp/attacker', PATH: '/usr/bin' } })
    )

    expect(result.spawnOptions.env).toEqual({ CLAUDE_CONFIG_DIR: LANE_DIR, PATH: '/usr/bin' })
    expect(result.spawnOptions.credentialLane).toEqual({
      principalId: '11111111-2222-4333-8444-555555555555'
    })
  })

  // Why a second key: the config-dir assertions above hold under EITHER write order, because the
  // sanitizer strips that one key from the client env anyway. Only a lane key the sanitizer does
  // not touch separates "written last" from "written at all" — and the lane preparation is free
  // to return one (§2 preamble, part 1 of the post-anchor invariant).
  it('writes every lane env key last, not only the one the sanitizer strips', () => {
    const result = computeLaneLaunch(
      laneOf({ envPatch: { ...PATCH, ORCA_LANE_MARKER: 'lane' } }),
      spawn({ env: { ORCA_LANE_MARKER: 'client', PATH: '/usr/bin' } })
    )

    expect(result.spawnOptions.env).toEqual({
      CLAUDE_CONFIG_DIR: LANE_DIR,
      ORCA_LANE_MARKER: 'lane',
      PATH: '/usr/bin'
    })
  })

  it('collapses a win32 case variant of any lane key, keeping the lane’s value', () => {
    const result = computeLaneLaunch(
      laneOf({ platform: 'win32', envPatch: { ...PATCH, ORCA_LANE_MARKER: 'lane' } }),
      spawn({ env: { Orca_Lane_Marker: 'client' } })
    )

    expect(Object.keys(result.spawnOptions.env ?? {}).sort()).toEqual([
      'CLAUDE_CONFIG_DIR',
      'ORCA_LANE_MARKER'
    ])
    expect(result.spawnOptions.env?.ORCA_LANE_MARKER).toBe('lane')
  })

  it('strips a CLAUDE_CONFIG_DIR deletion request so the provider replay cannot drop the lane', () => {
    const result = computeLaneLaunch(
      laneOf(),
      spawn({ env: {}, envToDelete: ['CLAUDE_CONFIG_DIR', 'TERM_PROGRAM'] })
    )

    expect(result.spawnOptions.envToDelete).toEqual(['TERM_PROGRAM'])
    expect(result.spawnOptions.env?.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
  })

  it('collapses a win32 case variant of the lane key rather than leaving both', () => {
    const result = computeLaneLaunch(
      laneOf({ platform: 'win32' }),
      spawn({ env: { Claude_Config_Dir: 'C:\\Users\\other\\.claude' } })
    )

    expect(Object.keys(result.spawnOptions.env ?? {})).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(result.spawnOptions.env?.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
  })

  it('scrubs launchConfig.agentEnv and hands the scrubbed config back', () => {
    const result = computeLaneLaunch(
      laneOf({ launchConfig: { agentEnv: { CLAUDE_CONFIG_DIR: '/tmp/x', FOO: '1' } } }),
      spawn({ env: {} })
    )

    expect(result.launchConfig?.agentEnv).toEqual({ FOO: '1' })
  })

  it('refuses an auth env var defined by the launch', () => {
    expect(
      refusalCodeOf(() => computeLaneLaunch(laneOf(), spawn({ env: { ANTHROPIC_API_KEY: 'x' } })))
    ).toBe('terminal.agent_env_refused')
  })

  it('refuses a settings-redirecting agentArgs', () => {
    expect(
      refusalCodeOf(() =>
        computeLaneLaunch(
          laneOf({ launchConfig: { agentArgs: '--settings /tmp/b.json' } }),
          spawn({ env: {} })
        )
      )
    ).toBe('terminal.agent_args_refused')
  })

  it('refuses an OpenClaude launch into a lane, by command and by launchAgent', () => {
    expect(refusalCodeOf(() => computeLaneLaunch(laneOf(), spawn({ command: 'openclaude' })))).toBe(
      'terminal.lane_agent_unsupported'
    )
    expect(
      refusalCodeOf(() => computeLaneLaunch(laneOf(), spawn({ launchAgent: 'openclaude' })))
    ).toBe('terminal.lane_agent_unsupported')
  })

  it('does not mistake `claude` for OpenClaude', () => {
    expect(computeLaneLaunch(laneOf(), spawn({ command: 'claude' })).spawnOptions.env).toEqual(
      PATCH
    )
  })

  it('refuses a lane spawn on a pane with a connectionId', () => {
    expect(refusalCodeOf(() => computeLaneLaunch(laneOf({ connectionId: 'ssh-1' }), {}))).toBe(
      'terminal.lane_remote_pane'
    )
  })

  it('fails closed when the lane is not loaded', () => {
    expect(refusalCodeOf(() => computeLaneLaunch(laneOf({ envPatch: null }), {}))).toBe(
      'terminal.lane_not_loaded'
    )
  })

  it('leaves a shared-lane spawn untouched', () => {
    const spawnOptions = spawn({
      env: { CLAUDE_CONFIG_DIR: '/tmp/client' },
      command: 'openclaude'
    })
    const result = computeLaneLaunch({ kind: 'shared' }, spawnOptions)

    expect(result.spawnOptions).toBe(spawnOptions)
    expect(result.spawnOptions.credentialLane).toBeUndefined()
  })
})

describe('computeLaneLaunch resume containment', () => {
  let root = ''
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-launch-'))
    mkdirSync(join(root, 'lane'), { recursive: true })
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    writeFileSync(join(root, 'lane', 'resume.jsonl'), '')
    writeFileSync(join(root, 'elsewhere', 'resume.jsonl'), '')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('allows a resume path inside the lane root', () => {
    const lane = laneOf({
      containmentRoots: [join(root, 'lane')],
      launchConfig: { ompResumeFilePath: join(root, 'lane', 'resume.jsonl') }
    })

    expect(() => computeLaneLaunch(lane, {})).not.toThrow()
  })

  it('refuses a resume path outside every allowed root', () => {
    const lane = laneOf({
      containmentRoots: [join(root, 'lane')],
      transcriptPath: join(root, 'elsewhere', 'resume.jsonl')
    })

    expect(refusalCodeOf(() => computeLaneLaunch(lane, {}))).toBe('terminal.resume_path_refused')
  })
})
