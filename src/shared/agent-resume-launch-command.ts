import type { ResumableTuiAgent } from './agent-session-resume'
import type { SessionOptionValue } from './native-chat-session-options'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import type { ResolvedAgentLaunchCommand } from './tui-agent-launch-command'
import type { AgentStartupPlan } from './tui-agent-startup'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'

function isClaudeResumeSelector(token: string): boolean {
  if (token === '--resume' || token.startsWith('--resume=')) {
    return true
  }
  if (token === '--continue' || token.startsWith('--continue=')) {
    return true
  }
  // Why: the joined -r<id> form is deliberately NOT matched — any `-r…` token
  // is ambiguous with another option's dash-leading value (`--agent -review`),
  // and no arity table can keep up with the CLI. Only exact selector shapes
  // are stripped; a persisted joined form degrades to pre-guard behavior.
  return token === '-r' || token.startsWith('-r=') || token === '-c' || token.startsWith('-c=')
}

/** [S10-21d R118, design (c)/(e)] Only a field actually present in `modelEffort` is ever
 * matched — an untouched field (undefined) never causes an unrelated existing flag to be cut,
 * which is what keeps the NULL-prefs case byte-identical to today (design (d)). */
function isClaudeModelOrEffortToken(
  token: string,
  modelEffort: { model?: string; effort?: string } | undefined
): boolean {
  if (modelEffort?.model !== undefined && (token === '--model' || token.startsWith('--model='))) {
    return true
  }
  return (
    modelEffort?.effort !== undefined && (token === '--effort' || token.startsWith('--effort='))
  )
}

/** [S10-21d R118, design (c)/(e)] Coerces a sessionOptions record's loosely-typed values
 * (SessionOptionValue = string | boolean) down to buildAgentResumeLaunchCommand's own
 * model/effort shape. Exported here (not tui-agent-startup.ts) since it exists purely to feed
 * this module's own new parameter. */
export function resumeModelEffort(o?: { model?: string | boolean; effort?: string | boolean }): {
  model?: string
  effort?: string
} {
  return {
    model: typeof o?.model === 'string' ? o.model : undefined,
    effort: typeof o?.effort === 'string' ? o.effort : undefined
  }
}

// [S10-21d R118, forced deviation — see RETURN] Split out of buildAgentResumeStartupPlan
// (tui-agent-startup.ts) purely to stay under that file's max-lines budget after this slice's
// modelEffort/sessionOptions fixes — no behavior change, this is the exact tail of that function
// (launchConfig construction included). `baseCommand` is `ResolvedAgentLaunchCommand |
// { ok: true; command: string }` (the `agentCommand` short-circuit has no
// commandWithoutSessionOptions/appliedSessionOptions — falls back to `.command` for both).
export function finishAgentResumeStartupPlan(
  args: {
    agent: ResumableTuiAgent
    agentArgs?: string | null
    agentEnv?: Record<string, string> | null
    ompResumeFilePath?: string | null
    sessionOptions?: Record<string, SessionOptionValue>
  },
  baseCommand: Extract<ResolvedAgentLaunchCommand, { ok: true }> | { ok: true; command: string },
  argv: readonly string[],
  shell: AgentStartupShell,
  expectedProcess: string
): AgentStartupPlan {
  const commandForLaunchConfig =
    'commandWithoutSessionOptions' in baseCommand
      ? baseCommand.commandWithoutSessionOptions
      : baseCommand.command
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentCommand: commandForLaunchConfig
  })
  const modelEffort = resumeModelEffort(args.sessionOptions)
  const appliedSessionOptions =
    'appliedSessionOptions' in baseCommand ? baseCommand.appliedSessionOptions : undefined
  return {
    agent: args.agent,
    launchCommand: buildAgentResumeLaunchCommand(
      args.agent,
      baseCommand.command,
      argv,
      shell,
      modelEffort
    ),
    expectedProcess,
    followupPrompt: null,
    launchConfig,
    ...(appliedSessionOptions
      ? Object.keys(appliedSessionOptions).length > 0
        ? { sessionOptions: { ...appliedSessionOptions } }
        : {}
      : {}),
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}

function isClaudeExecutableToken(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? ''
  return /^claude(\.(exe|cmd|bat|ps1))?$/i.test(base)
}

/** Accepts a claude token only in command position — index 0, right after a
 * wrapper's `--`, behind PowerShell's `&` call operator, or preceded solely by
 * NAME=value assignments — so an argument that merely ends in /claude (an ssh
 * key, a project dir) can never be mistaken for the executable.
 *
 * [S10-21a C3-v2, errata 5(p) §C.3/§C.4] Exported so the launch-admission classifier
 * (`agent-launch-admission.ts`) can locate the claude token itself, sharing exactly this
 * command-position discipline rather than re-implementing it. */
export function findClaudeExecutableIndex(
  tokens: readonly string[],
  shell: AgentStartupShell
): number {
  let commandPosition = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (commandPosition) {
      if (isClaudeExecutableToken(token)) {
        return i
      }
      if (
        // Why: `NAME=value cmd` is posix-only syntax; on cmd/PowerShell such a
        // token is just a bogus executable name, not a prefix to skip.
        (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
        (shell === 'powershell' && token === '&' && i === 0)
      ) {
        continue
      }
      commandPosition = false
    }
    if (token === '--') {
      commandPosition = true
    }
  }
  return -1
}

/** Joins the resolved base command with the agent's resume argv. Claude goes
 * through the selector guard below; other agents keep plain appending. */
export function buildAgentResumeLaunchCommand(
  agent: ResumableTuiAgent,
  baseCommand: string,
  resumeArgv: readonly string[],
  shell: AgentStartupShell,
  // [S10-21d R118, design (c)/(e)] Claude-only (the design's own catalog citation is Claude's
  // `--model`/`--effort`, agent-session-option-catalog-claude-codex.ts:88/164-166) — undefined
  // fields are never stripped or added, so a pane with no stored prefs gets a byte-identical
  // command to today (design (d)).
  modelEffort?: { model?: string; effort?: string }
): string {
  const argv = resumeArgv.slice(1)
  if (agent === 'claude') {
    return buildClaudeResumeLaunchCommand(baseCommand, argv, shell, modelEffort)
  }
  const resumeArgs = argv.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  return resumeArgs ? `${baseCommand} ${resumeArgs}` : baseCommand
}

/** Builds the Claude cold-restore launch command: strips any resume/continue
 * selector the user's persisted command carries and appends exactly one
 * authoritative selector, so a stale or bare selector can never compete with
 * the provider session id (#12982).
 *
 * Fails open by design: when the base command cannot be tokenized, or no
 * claude executable token can be located (wrapper commands like
 * `bash -c claude`), the base is left byte-for-byte untouched and the
 * selector is appended, which is the pre-guard behavior. Bytes outside
 * removed selector tokens are always preserved verbatim — the base is
 * spliced by source span, never re-quoted. */
export function buildClaudeResumeLaunchCommand(
  baseCommand: string,
  resumeArgs: readonly string[],
  shell: AgentStartupShell,
  modelEffort?: { model?: string; effort?: string }
): string {
  const quotedResume = resumeArgs.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  const quotedModelEffort = [
    ...(modelEffort?.model !== undefined ? ['--model', modelEffort.model] : []),
    ...(modelEffort?.effort !== undefined ? ['--effort', modelEffort.effort] : [])
  ]
    .map((arg) => quoteStartupArg(arg, shell))
    .join(' ')
  const insertion = [quotedModelEffort, quotedResume].filter(Boolean).join(' ')
  if (!insertion) {
    return baseCommand
  }
  const appended = `${baseCommand} ${insertion}`
  const tokenized = tokenizeStartupCommand(baseCommand, shell)
  if (!tokenized.ok) {
    return appended
  }
  const { tokens, spans } = tokenized
  const claudeIndex = findClaudeExecutableIndex(tokens, shell)
  if (claudeIndex === -1) {
    return appended
  }
  // Why: any token the tokenizer cannot model for this shell — an operator,
  // comment, expansion, or cmd single-quoted region — means the splice could
  // cut live syntax or misread a literal as a selector. The whole base must
  // be modelable, including the executable itself; only PowerShell's leading
  // call operator is a known-safe divergent token.
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? baseCommand.length : spans[i].start
    if (!/^[ \t]*$/.test(baseCommand.slice(gapStart, gapEnd))) {
      return appended
    }
    if (i === tokens.length) {
      break
    }
    // Why: a bare `--%` makes PowerShell pass the rest of the line to the
    // child literally, so appended quoting would arrive as literal bytes. A
    // quoted `--%` can also stop parsing, but only before a parameter token,
    // where the base is already mangled with or without the guard.
    if (shell === 'powershell' && baseCommand.slice(spans[i].start, spans[i].end) === '--%') {
      return appended
    }
    if (spans[i].divergesFromShell) {
      const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
      if (!isCallOperator) {
        return appended
      }
    }
  }
  const cuts: { start: number; end: number }[] = []
  let terminatorStart: number | null = null
  for (let i = claudeIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--') {
      // Why: claude is the executable here, so `--` is claude's own
      // terminator; the selector must stay in option position before it.
      // Span-splice equivalent of insertBeforeTerminator in
      // tui-agent-launch-command.ts, which re-quotes and cannot be reused.
      terminatorStart = spans[i].start
      break
    }
    const isSelector = isClaudeResumeSelector(token)
    const isModelOrEffort = !isSelector && isClaudeModelOrEffortToken(token, modelEffort)
    if (!isSelector && !isModelOrEffort) {
      continue
    }
    // Why: absorb the separator before the selector, but never cross into the
    // previous token, whose span can end with an escaped-space byte.
    let start = spans[i].start
    while (start > spans[i - 1].end && ' \t'.includes(baseCommand[start - 1])) {
      start -= 1
    }
    let end = spans[i].end
    const next = tokens[i + 1]
    const bareWithValue =
      ((isSelector && (token === '--resume' || token === '-r')) ||
        (isModelOrEffort && (token === '--model' || token === '--effort'))) &&
      next !== undefined &&
      !next.startsWith('-')
    if (bareWithValue) {
      // A stale session locator, model id, or effort level rides along with its flag.
      end = spans[i + 1].end
      i += 1
    }
    cuts.push({ start, end })
  }
  let result = baseCommand
  if (terminatorStart !== null) {
    result = `${result.slice(0, terminatorStart)}${insertion} ${result.slice(terminatorStart)}`
  }
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    result = `${result.slice(0, cuts[i].start)}${result.slice(cuts[i].end)}`
  }
  return terminatorStart !== null ? result : `${result} ${insertion}`
}

export type ClaudeSessionIdSpliceResult = { ok: true; command: string } | { ok: false }

/** [S10-21a C3-v2, errata 5(p) §C.4 HOST_MINTED] Inserts `--session-id <id>` immediately after
 * the claude executable token, by source span, shell-safe quoted, never string concatenation.
 * Reuses `buildClaudeResumeLaunchCommand`'s divergence discipline but FAIL-CLOSED: where that
 * function falls back to `appended` on a tokenizer divergence, this returns `{ok:false}` — it
 * never splices a line it could not fully model. Only ever called on a launch with no existing
 * selector/refusal token (classification already refused those shapes), so this only ever adds a
 * token; nothing is stripped. */
export function spliceHostMintedSessionId(
  command: string,
  sessionId: string,
  shell: AgentStartupShell
): ClaudeSessionIdSpliceResult {
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return { ok: false }
  }
  const { tokens, spans } = tokenized
  const claudeIndex = findClaudeExecutableIndex(tokens, shell)
  if (claudeIndex === -1) {
    return { ok: false }
  }
  for (let i = 0; i <= tokens.length; i += 1) {
    const gapStart = i === 0 ? 0 : spans[i - 1].end
    const gapEnd = i === tokens.length ? command.length : spans[i].start
    if (!/^[ \t]*$/.test(command.slice(gapStart, gapEnd))) {
      return { ok: false }
    }
    if (i === tokens.length) {
      break
    }
    if (shell === 'powershell' && command.slice(spans[i].start, spans[i].end) === '--%') {
      return { ok: false }
    }
    if (spans[i].divergesFromShell) {
      const isCallOperator = shell === 'powershell' && i === 0 && tokens[i] === '&'
      if (!isCallOperator) {
        return { ok: false }
      }
    }
  }
  const insertAt = spans[claudeIndex].end
  const flag = `--session-id ${quoteStartupArg(sessionId, shell)}`
  return { ok: true, command: `${command.slice(0, insertAt)} ${flag}${command.slice(insertAt)}` }
}
