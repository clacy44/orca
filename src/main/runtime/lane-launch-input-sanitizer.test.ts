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
    ['agentEnv', { agentEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'x' } }]
  ])('refuses an auth env var defined in %s', (_surface, input) => {
    const result = sanitizeLaneLaunchEnv(input)

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.refusal.code).toBe('terminal.agent_env_refused')
  })

  it('allows auth vars in envToDelete, which every lane pane already asks for', () => {
    // Why: pty.ts builds authEnvToDelete as CLAUDE_AUTH_ENV_VARS + ANTHROPIC_CUSTOM_HEADERS
    // whenever stripAuthEnv is set, and §2a arms that on every lane pane. Refusing the
    // deletion list would refuse every lane launch. Defining is the attack; deleting is not.
    const envToDelete = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_CUSTOM_HEADERS'
    ]

    const result = sanitizeLaneLaunchEnv({ envToDelete })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.envToDelete).toEqual(envToDelete)
  })

  it('folds env-key case on win32 for both the refusal and the config-dir strip', () => {
    expect(sanitizeLaneLaunchEnv({ env: { anthropic_api_key: 'x' }, platform: 'win32' }).ok).toBe(
      false
    )
    expect(sanitizeLaneLaunchEnv({ env: { anthropic_api_key: 'x' }, platform: 'linux' }).ok).toBe(
      true
    )

    const win32 = sanitizeLaneLaunchEnv({
      env: { claude_config_dir: 'C:\\victim' },
      envToDelete: ['Claude_Config_Dir'],
      platform: 'win32'
    })

    expect(win32.ok).toBe(true)
    if (!win32.ok) {
      return
    }
    expect(win32.env).toEqual({})
    expect(win32.envToDelete).toEqual([])
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

describe('sanitizeLaneLaunchEnv — ANTHROPIC_CUSTOM_HEADERS', () => {
  it('refuses an auth-bearing custom-headers value', () => {
    const result = sanitizeLaneLaunchEnv({
      env: { ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: sk-ant-attacker' }
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal.code).toBe('terminal.agent_env_refused')
  })

  it('refuses it in agentEnv, and in a lower-cased key on win32', () => {
    expect(
      sanitizeLaneLaunchEnv({
        agentEnv: { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer sk' }
      }).ok
    ).toBe(false)
    expect(
      sanitizeLaneLaunchEnv({
        env: { anthropic_custom_headers: 'x-api-key: sk' },
        platform: 'win32'
      }).ok
    ).toBe(false)
  })

  // Negative control: a header value that carries no credential is not an auth override, and
  // `stripAuthEnv` leaves it alone too — refusing it would refuse legitimate launches.
  it('passes a custom-headers value that carries no credential', () => {
    const result = sanitizeLaneLaunchEnv({ env: { ANTHROPIC_CUSTOM_HEADERS: 'x-trace-id: 42' } })

    expect(result.ok).toBe(true)
    expect(result.ok === true && result.env).toEqual({ ANTHROPIC_CUSTOM_HEADERS: 'x-trace-id: 42' })
  })

  // Negative control for the fold: on POSIX the lower-cased key is a different variable.
  it('passes a lower-cased custom-headers key on linux', () => {
    expect(
      sanitizeLaneLaunchEnv({
        env: { anthropic_custom_headers: 'x-api-key: sk' },
        platform: 'linux'
      }).ok
    ).toBe(true)
  })
})

describe('sanitizeLaneLaunchCommand — inline env assignments', () => {
  it('refuses a lower-cased config-dir assignment on win32', () => {
    const result = sanitizeLaneLaunchCommand({
      agentArgs: 'claude_config_dir=C:\\victim\\auth claude',
      platform: 'win32'
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.refusal.code).toBe('terminal.agent_args_refused')
  })

  it('refuses a lower-cased auth-var assignment on win32', () => {
    expect(
      sanitizeLaneLaunchCommand({ agentArgs: 'anthropic_api_key=sk claude', platform: 'win32' }).ok
    ).toBe(false)
  })

  it('refuses an ANTHROPIC_CUSTOM_HEADERS assignment', () => {
    expect(sanitizeLaneLaunchCommand({ agentArgs: 'ANTHROPIC_CUSTOM_HEADERS=x claude' }).ok).toBe(
      false
    )
  })

  // Negative control: on POSIX the lower-cased name is a different variable the CLI never reads.
  it('passes a lower-cased assignment on linux', () => {
    expect(
      sanitizeLaneLaunchCommand({
        agentArgs: 'claude_config_dir=/tmp/victim claude',
        platform: 'linux'
      }).ok
    ).toBe(true)
  })
})
