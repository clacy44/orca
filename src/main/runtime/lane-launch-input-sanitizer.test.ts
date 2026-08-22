import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REFUSED_LANE_LAUNCH_FLAGS,
  assertLaneResumePathsContained,
  sanitizeLaneLaunchCommand,
  sanitizeLaneLaunchEnv
} from './lane-launch-input-sanitizer'

describe('sanitizeLaneLaunchEnv', () => {
  it('strips CLAUDE_CONFIG_DIR from env, agentEnv and the deletion list', () => {
    const result = sanitizeLaneLaunchEnv({
      env: { CLAUDE_CONFIG_DIR: '/tmp/a', PATH: '/usr/bin' },
      agentEnv: { CLAUDE_CONFIG_DIR: '/tmp/b', FOO: '1' },
      envToDelete: ['CLAUDE_CONFIG_DIR', 'TERM_PROGRAM']
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.env).toEqual({ PATH: '/usr/bin' })
    expect(result.agentEnv).toEqual({ FOO: '1' })
    expect(result.envToDelete).toEqual(['TERM_PROGRAM'])
  })

  it.each([
    ['env', { env: { ANTHROPIC_API_KEY: 'x' } }],
    ['agentEnv', { agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }],
    ['envToDelete', { envToDelete: ['ANTHROPIC_AUTH_TOKEN'] }]
  ])('refuses an auth env var in %s', (_surface, input) => {
    const result = sanitizeLaneLaunchEnv(input)

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.refusal.code).toBe('terminal.agent_env_refused')
  })

  it('leaves absent surfaces absent', () => {
    const result = sanitizeLaneLaunchEnv({})

    expect(result).toEqual({ ok: true })
  })
})

describe('sanitizeLaneLaunchCommand', () => {
  it.each(REFUSED_LANE_LAUNCH_FLAGS)('refuses %s in agentArgs', (flag) => {
    const result = sanitizeLaneLaunchCommand({ agentArgs: `--verbose ${flag} /tmp/theirs.json` })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.refusal.code).toBe('terminal.agent_args_refused')
  })

  it('refuses a refused flag hidden behind quoting in agentCommand', () => {
    const result = sanitizeLaneLaunchCommand({ agentCommand: `claude "--settings" '/tmp/x.json'` })

    expect(result.ok).toBe(false)
  })

  it('refuses --settings=value written as one token', () => {
    expect(sanitizeLaneLaunchCommand({ agentArgs: '--settings=/tmp/x.json' }).ok).toBe(false)
  })

  it('refuses an inline CLAUDE_CONFIG_DIR assignment', () => {
    const result = sanitizeLaneLaunchCommand({ agentCommand: 'CLAUDE_CONFIG_DIR=/tmp/lane claude' })

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.refusal.code).toBe('terminal.agent_args_refused')
  })

  it('allows ordinary agent args', () => {
    expect(
      sanitizeLaneLaunchCommand({
        agentCommand: 'claude',
        agentArgs: '--model sonnet --add-dir "/home/me/My Repos/app"'
      })
    ).toEqual({ ok: true })
  })

  it('allows an empty launch', () => {
    expect(sanitizeLaneLaunchCommand({})).toEqual({ ok: true })
  })
})

describe('assertLaneResumePathsContained', () => {
  let root = ''
  let outside = ''

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-lane-root-'))
    outside = mkdtempSync(join(tmpdir(), 'orca-lane-outside-'))
    mkdirSync(join(root, 'transcripts'), { recursive: true })
    writeFileSync(join(root, 'transcripts', 'a.jsonl'), '')
    writeFileSync(join(outside, 'b.jsonl'), '')
    symlinkSync(join(outside, 'b.jsonl'), join(root, 'escape.jsonl'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('allows a path inside an allowed root', () => {
    expect(
      assertLaneResumePathsContained({ transcriptPath: join(root, 'transcripts', 'a.jsonl') }, [
        root
      ])
    ).toEqual({ ok: true })
  })

  it('refuses a path outside every allowed root', () => {
    const result = assertLaneResumePathsContained({ ompResumeFilePath: join(outside, 'b.jsonl') }, [
      root
    ])

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.refusal.code).toBe('terminal.resume_path_refused')
  })

  it('refuses a symlink that escapes the root', () => {
    expect(
      assertLaneResumePathsContained({ transcriptPath: join(root, 'escape.jsonl') }, [root]).ok
    ).toBe(false)
  })

  it('refuses a path that does not exist', () => {
    expect(
      assertLaneResumePathsContained({ transcriptPath: join(root, 'missing.jsonl') }, [root]).ok
    ).toBe(false)
  })

  it('ignores absent resume paths', () => {
    expect(assertLaneResumePathsContained({}, [root])).toEqual({ ok: true })
  })
})
