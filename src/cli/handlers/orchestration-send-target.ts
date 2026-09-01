// S10-15 F1 R1 (R12 max-lines ratchet: new file rather than growing orchestration.ts): resolves
// `orchestration send --to <name@host>` CLI-side, the same way `agents ask` already resolves
// `name@host` (agents-shared.ts) — the target host is the authority for whether the agent
// exists/is quarantined, a read the CLI is already permitted to make unattested.
import type { RuntimeClient } from '../runtime-client'
import { parseAgentSelector, resolveAgentAcrossHost, requireNonQuarantined } from './agents-shared'
import { LOCAL_FIND_HOST } from './agents-cross-host'

export type ResolvedSendTarget = { to: string; host?: string }

// Order matters: group addresses and prefixed mailboxes are returned untouched, so `@all`,
// `run:`/`dispatch:`/`agent:` (unqualified) behave exactly as today. Finding 11: a bare
// display-name-shaped recipient is NOT refused here — only the runtime (orchestration.send)
// holds the live terminal-handle map needed to tell a legacy bare handle apart from a genuinely
// unknown name, so that refusal lives runtime-side, not in this CLI-side resolver.
export async function resolveSendTarget(
  client: RuntimeClient,
  userDataPath: string,
  raw: string,
  hostClientFactory?: (environmentId: string) => RuntimeClient
): Promise<ResolvedSendTarget> {
  if (raw.startsWith('@') || raw.startsWith('run:') || raw.startsWith('dispatch:')) {
    return { to: raw }
  }
  const hasAgentPrefix = raw.startsWith('agent:')
  const rest = hasAgentPrefix ? raw.slice('agent:'.length) : raw
  const selector = parseAgentSelector(rest)
  if (selector.host === LOCAL_FIND_HOST) {
    // Unqualified `agent:<id>` (or a legacy bare handle) — unchanged.
    return { to: raw }
  }
  const resolved = await resolveAgentAcrossHost(client, userDataPath, rest, hostClientFactory)
  requireNonQuarantined(resolved.agent)
  return { to: `agent:${resolved.agent.id}`, host: resolved.host }
}
