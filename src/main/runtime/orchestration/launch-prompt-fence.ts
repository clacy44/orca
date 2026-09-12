// [R197] INV-P-LAUNCH-EDGE: from the moment the host delivers a launch command into a pane
// until the LAUNCHED agent itself is observed at its prompt in that pane generation, no
// host-authored bytes (pointer text, Enter, prompt injection) may be written into that pane.
// A shell that titles itself after the command it is about to run is not the agent: with shell
// auto-titling on, the bare token `claude` classifies as an idle AGENT_NAMES title
// (agent-title-status.ts:198-201,225), so `detectAgentStatusFromTitle` cannot be the authority
// for "the launched agent exists" — only Claude's own status glyphs are. Kept pure and
// file-local (no orca-runtime.ts import) so it can be unit-tested without the runtime's
// fake-timer/mock-db harness — orca-runtime.ts is on the max-lines ratchet allowlist, so this
// logic lives here rather than growing that file (same precedent as
// orchestration/delivery-starvation.ts).
import { CLAUDE_IDLE, containsAgentSpinnerGlyph } from '../../../shared/agent-title-core'

export const LAUNCH_PROMPT_FENCE_MAX_MS = 5 * 60 * 1000

/** True when `rawTitle` is evidence the LAUNCHED claude process itself is painting this pane.
 *  A shell that titles itself after the command it is about to run is not evidence: the bare
 *  token `claude` classifies as an idle agent title (agent-title-status.ts:198-201,225), so the
 *  detector cannot be the authority here. Only Claude's own status glyphs are. */
export function isLaunchedClaudePromptTitle(rawTitle: string): boolean {
  const t = rawTitle.trim()
  return t === CLAUDE_IDLE || t.startsWith(`${CLAUDE_IDLE} `) || containsAgentSpinnerGlyph(t)
}

/** True when the fence has been held longer than `maxMs` — expiry falls back to the pre-fence
 *  ladder (never to a write of its own) so a Claude build that emits no glyph title can never
 *  deafen a pane permanently. */
export function isLaunchPromptFenceExpired(since: number, now: number, maxMs: number): boolean {
  return now - since >= maxMs
}
