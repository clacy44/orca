// S10-21a C3-v2 (errata 5(p) v2.1 §C.2-§C.4): unit coverage for the pure classification helpers.
// No DB, no lock — these are exactly the functions admission composes.
import { describe, expect, it } from 'vitest'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import {
  claudeIndexInSubject,
  resolveExecutedChannel,
  scanEffectiveResumeId,
  scanRefusal,
  tokensOfSubject
} from './agent-launch-classification'
import type { LaunchAdmission } from './agent-launch-admission'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'

const CALLER: LaunchAdmission = { kind: 'caller' }

function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
  return { cols: 80, rows: 24, ...overrides }
}

describe('S10-21a C3-v2, errata 5(p) §C.2: resolveExecutedChannel', () => {
  it('T29/base: with no sequencedAgentLine, subject is spawnOptions.command, channel is "command"', () => {
    const result = resolveExecutedChannel(opts({ command: 'claude' }), CALLER, 'posix')
    expect(result).toEqual({ ok: true, subject: 'claude', channel: 'command' })
  })

  it('T48: a decoy env var is never selected when sequencedAgentLine is absent, and flags ambiguity when both channels carry claude', () => {
    const decoyEnv = { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --model opus' }
    const bothClaude = resolveExecutedChannel(
      opts({ command: 'claude', env: decoyEnv }),
      CALLER,
      'posix'
    )
    expect(bothClaude).toEqual({ ok: false, reason: 'ambiguous_launch_channel' })

    // Command carries no claude token: the decoy env value is never treated as the executed
    // subject just because it exists — subject stays spawnOptions.command (channel 'command').
    const onlyDecoy = resolveExecutedChannel(
      opts({ command: 'bash -lc wrapper', env: decoyEnv }),
      CALLER,
      'posix'
    )
    expect(onlyDecoy).toEqual({
      ok: true,
      subject: 'bash -lc wrapper',
      channel: 'command'
    })
  })

  it('T38(b): a host-set sequencedAgentLine matching the env selects the env channel', () => {
    const seq = 'claude --model opus'
    const admission: LaunchAdmission = { kind: 'caller', sequencedAgentLine: seq }
    const result = resolveExecutedChannel(
      opts({
        command: 'bash -lc \'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"\'',
        env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: seq }
      }),
      admission,
      'posix'
    )
    expect(result).toEqual({ ok: true, subject: seq, channel: 'env' })
  })

  it('T38(b) mismatch: sequencedAgentLine disagreeing with the actual env is sequenced_channel_mismatch', () => {
    const admission: LaunchAdmission = { kind: 'caller', sequencedAgentLine: 'claude --model opus' }
    const result = resolveExecutedChannel(
      opts({ env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --model sonnet' } }),
      admission,
      'posix'
    )
    expect(result).toEqual({ ok: false, reason: 'sequenced_channel_mismatch' })
  })

  it('sequencedAgentLine channel is refused as ambiguous when command ALSO carries claude', () => {
    const seq = 'claude --model opus'
    const admission: LaunchAdmission = { kind: 'caller', sequencedAgentLine: seq }
    const result = resolveExecutedChannel(
      opts({ command: 'claude', env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: seq } }),
      admission,
      'posix'
    )
    expect(result).toEqual({ ok: false, reason: 'ambiguous_launch_channel' })
  })
})

describe('S10-21a C3-v2, errata 5(p) §C.4 steps 5a/5b: scanRefusal (T29)', () => {
  it("refuses --session-id anywhere after claude, including after claude's own --", () => {
    const tokens = tokensOfSubject('claude -- --session-id evil', 'posix')
    const claudeIndex = claudeIndexInSubject('claude -- --session-id evil', 'posix')
    expect(scanRefusal(tokens, claudeIndex)).toBe('launch_session_id_forbidden')
  })

  it('refuses --fork-session anywhere after claude', () => {
    const tokens = tokensOfSubject('claude --fork-session', 'posix')
    const claudeIndex = claudeIndexInSubject('claude --fork-session', 'posix')
    expect(scanRefusal(tokens, claudeIndex)).toBe('launch_fork_forbidden')
  })

  it('finds no refusal on an ordinary bare launch', () => {
    const tokens = tokensOfSubject('claude --model opus', 'posix')
    const claudeIndex = claudeIndexInSubject('claude --model opus', 'posix')
    expect(scanRefusal(tokens, claudeIndex)).toBeNull()
  })
})

describe('S10-21a C3-v2, errata 5(p) §C.4 step 5c / errata 5(r)/(u): scanEffectiveResumeId', () => {
  function effectiveId(command: string) {
    const tokens = tokensOfSubject(command, 'posix')
    const claudeIndex = claudeIndexInSubject(command, 'posix')
    return scanEffectiveResumeId(tokens, claudeIndex)
  }

  it('no selector -> none (HOST_MINTED candidate)', () => {
    expect(effectiveId('claude --model opus')).toEqual({ kind: 'none' })
  })

  it('--resume <id> -> id', () => {
    expect(effectiveId('claude --resume sess-a')).toEqual({ kind: 'id', sessionId: 'sess-a' })
  })

  it('errata 5(r): repeated --resume -> LAST wins', () => {
    expect(effectiveId('claude --resume sess-a --resume sess-b')).toEqual({
      kind: 'id',
      sessionId: 'sess-b'
    })
  })

  it('joined -r<id> and -r=<id> both extract the id', () => {
    expect(effectiveId('claude -rsess-a')).toEqual({ kind: 'id', sessionId: 'sess-a' })
    expect(effectiveId('claude -r=sess-a')).toEqual({ kind: 'id', sessionId: 'sess-a' })
  })

  it('a trailing --resume with no following id is undeterminable', () => {
    expect(effectiveId('claude --resume')).toEqual({ kind: 'undeterminable' })
  })

  it('errata 5(u): --continue is ALWAYS undeterminable, never an id, regardless of resume elsewhere', () => {
    expect(effectiveId('claude --continue')).toEqual({ kind: 'undeterminable' })
    expect(effectiveId('claude --resume sess-a --continue')).toEqual({ kind: 'undeterminable' })
  })

  it("a selector after claude's own -- is not scanned for id purposes (step 5c stops at --)", () => {
    expect(effectiveId('claude -- --resume sess-a')).toEqual({ kind: 'none' })
  })
})
