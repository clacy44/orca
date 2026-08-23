import { isTuiAgent } from '../../shared/tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from '../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../shared/tui-agent'

/**
 * The one thing a lane KEEPS out of a host-wide launch setting: an explicit permission narrowing.
 *
 * Dropping `agentDefaultArgs`/`agentDefaultEnv` wholesale also drops the local human's opt-out —
 * AgentsPane's "manual" mode writes `agentDefaultArgs[agent] = ''`, and `resolveTuiAgentLaunchArgs`
 * reads an ABSENT key as "use Orca's default", which is the YOLO flag. Emptying the record
 * collapses "key present and cleared" into "key absent", so every lane pane would silently
 * re-enable `--dangerously-skip-permissions` while the shared pane beside it honoured the opt-out.
 * S9 §2a loss-list item (iv) states the rule for the widening direction; this is its mirror.
 *
 * Kept only when the value carries no token Orca's own default does not already carry AND drops
 * at least one of them: a narrowing by construction, and it can hold nothing a peer authored.
 * Anything else — the default itself, or a value with a foreign token — is dropped and the lane
 * falls back to Orca's host-computed default, unchanged.
 */
export function laneNarrowedAgentDefaultArgs(
  configured: Partial<Record<TuiAgent, string>> | null | undefined
): Partial<Record<TuiAgent, string>> {
  const narrowed: Partial<Record<TuiAgent, string>> = {}
  for (const [agent, args] of Object.entries(configured ?? {})) {
    if (isTuiAgent(agent) && typeof args === 'string' && isArgsNarrowing(agent, args)) {
      // Re-joined from the tokens the subset was judged on, so nothing but those tokens travels.
      narrowed[agent] = argsTokens(args).join(' ')
    }
  }
  return narrowed
}

export function laneNarrowedAgentDefaultEnv(
  configured: Partial<Record<TuiAgent, Record<string, string>>> | null | undefined
): Partial<Record<TuiAgent, Record<string, string>>> {
  const narrowed: Partial<Record<TuiAgent, Record<string, string>>> = {}
  for (const [agent, env] of Object.entries(configured ?? {})) {
    if (isTuiAgent(agent) && env && typeof env === 'object' && isEnvNarrowing(agent, env)) {
      narrowed[agent] = { ...env }
    }
  }
  return narrowed
}

function argsTokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean)
}

function isArgsNarrowing(agent: TuiAgent, value: string): boolean {
  const yolo = argsTokens(YOLO_TUI_AGENT_ARGS[agent] ?? '')
  const tokens = argsTokens(value)
  return tokens.length < yolo.length && tokens.every((token) => yolo.includes(token))
}

function isEnvNarrowing(agent: TuiAgent, value: Record<string, string>): boolean {
  const yolo = YOLO_TUI_AGENT_ENV[agent] ?? {}
  const entries = Object.entries(value)
  return (
    entries.length < Object.keys(yolo).length && entries.every(([key, item]) => yolo[key] === item)
  )
}
