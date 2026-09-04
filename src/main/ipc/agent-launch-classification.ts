// S10-21a C3-v2 (errata 5(p) v2.1 §C.2-§C.4): pure classification helpers, split out of
// agent-launch-admission.ts to stay under the repo's max-lines budget. No DB access here — every
// function is a function of `spawnOptions`/tokens only, so it is unit-testable without a store.
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import { findClaudeExecutableIndex } from '../../shared/agent-resume-launch-command'
import {
  isContinueSelectorToken,
  isForkSessionRefusalToken,
  isResumeSelectorToken,
  isSessionIdRefusalToken,
  resumeSelectorJoinedId
} from '../../shared/covered-launch-agents'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { LaunchAdmission } from './agent-launch-admission'

export function resolveAdmissionShell(spawnOptions: PtySpawnOptions): AgentStartupShell {
  if (process.platform !== 'win32') {
    return 'posix'
  }
  if (spawnOptions.terminalWindowsWslDistro) {
    return 'posix'
  }
  return resolveWindowsShellStartupFamily(spawnOptions.shellOverride)
}

export function locateClaude(subject: string, shell: AgentStartupShell): boolean {
  const tokenized = tokenizeStartupCommand(subject, shell)
  return tokenized.ok && findClaudeExecutableIndex(tokenized.tokens, shell) !== -1
}

/** claude's index in `subject`'s tokens, or -1 if unlocatable/untokenizable. */
export function claudeIndexInSubject(subject: string, shell: AgentStartupShell): number {
  const tokenized = tokenizeStartupCommand(subject, shell)
  if (!tokenized.ok) {
    return -1
  }
  return findClaudeExecutableIndex(tokenized.tokens, shell)
}

export function tokensOfSubject(subject: string, shell: AgentStartupShell): string[] {
  const tokenized = tokenizeStartupCommand(subject, shell)
  return tokenized.ok ? tokenized.tokens : []
}

export type ChannelResolution =
  | { ok: true; subject: string; channel: 'env' | 'command' }
  | { ok: false; reason: 'sequenced_channel_mismatch' | 'ambiguous_launch_channel' }

/** [§C.2] `env` is wire-accepted and survives into the spawn env, so the env channel may never be
 * selected on the strength of anything a caller can set — only a host-set, non-wire
 * `admission.sequencedAgentLine` can. */
export function resolveExecutedChannel(
  spawnOptions: PtySpawnOptions,
  admission: LaunchAdmission,
  shell: AgentStartupShell
): ChannelResolution {
  const seq = spawnOptions.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (admission.sequencedAgentLine !== undefined) {
    if (admission.sequencedAgentLine !== seq) {
      return { ok: false, reason: 'sequenced_channel_mismatch' }
    }
    if (spawnOptions.command !== undefined && locateClaude(spawnOptions.command, shell)) {
      return { ok: false, reason: 'ambiguous_launch_channel' }
    }
    return { ok: true, subject: seq as string, channel: 'env' }
  }
  const commandHasClaude =
    spawnOptions.command !== undefined && locateClaude(spawnOptions.command, shell)
  const seqHasClaude = seq !== undefined && locateClaude(seq, shell)
  if (commandHasClaude && seqHasClaude) {
    return { ok: false, reason: 'ambiguous_launch_channel' }
  }
  return { ok: true, subject: spawnOptions.command ?? '', channel: 'command' }
}

export type EffectiveResumeId =
  | { kind: 'none' }
  | { kind: 'undeterminable' }
  | { kind: 'id'; sessionId: string }

/** [§C.4 step 5c, errata 5(r)/(u)] Scans tokens after the claude index and before claude's own
 * `--`. Repeated `--resume`/`-r` -> last wins (5(r)). Any `--continue`/`-c` in the scan region
 * forces `undeterminable` regardless of a resume id elsewhere — 5(u): continue/-c select by
 * project recency, never by id, and can never satisfy SELF_RESUME. [JUDGMENT CALL, see RETURN]:
 * the spec does not rule the mixed `--resume <id> --continue` ordering; this treats ANY continue
 * token as forcing `undeterminable`, the conservative direction (never over-claims an id). */
export function scanEffectiveResumeId(
  tokens: readonly string[],
  claudeIndex: number
): EffectiveResumeId {
  let sawContinue = false
  let lastId: string | undefined
  let sawIdlessSelector = false
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      break
    }
    if (isContinueSelectorToken(token)) {
      sawContinue = true
      continue
    }
    if (!isResumeSelectorToken(token)) {
      continue
    }
    const joined = resumeSelectorJoinedId(token)
    if (joined !== undefined) {
      lastId = joined
      continue
    }
    const next = tokens[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      lastId = next
      i += 1
    } else {
      sawIdlessSelector = true
    }
  }
  if (sawContinue) {
    return { kind: 'undeterminable' }
  }
  if (lastId !== undefined) {
    return { kind: 'id', sessionId: lastId }
  }
  if (sawIdlessSelector) {
    return { kind: 'undeterminable' }
  }
  return { kind: 'none' }
}

/** [§C.4 steps 5a/5b] Over ALL tokens after the claude index, INCLUDING tokens after claude's own
 * `--` (F-H5) — a hard refusal must not be strippable by hiding the flag past a terminator. */
export function scanRefusal(
  tokens: readonly string[],
  claudeIndex: number
): 'launch_session_id_forbidden' | 'launch_fork_forbidden' | null {
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    if (isSessionIdRefusalToken(tokens[i])) {
      return 'launch_session_id_forbidden'
    }
    if (isForkSessionRefusalToken(tokens[i])) {
      return 'launch_fork_forbidden'
    }
  }
  return null
}
