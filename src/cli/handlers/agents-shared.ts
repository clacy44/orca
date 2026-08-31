// S10-2c: small helpers shared by the `orca agents *` write/read verbs added across
// agents-threads.ts / agents-ask-reply.ts / agents-containment.ts — split out (rather than
// growing agents.ts) to stay under the repo's max-lines ratchet, same precedent as
// orchestration-agents.ts splitting into orchestration-agents-*.ts.
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'

export type ResolvedAgentIdentity = {
  id: string
  displayName: string
  terminalHandle?: string | null
  quarantined: boolean
}

type AgentGetResult = {
  agent: {
    id: string
    displayName: string
    terminalHandle?: string | null
    quarantined: boolean
  }
}

// Why: `agents ask <name>`, `agents purge`, and `agents review <agent>` all take one positional
// that can be either a display name (ASCII slug, no underscore) or an `agt_`-prefixed id — id is
// the only shape a name can never take, matching `agents show`/`agents quarantine`'s existing rule.
export function nameOrId(value: string): { name?: string; id?: string } {
  return value.startsWith('agt_') ? { id: value } : { name: value }
}

// Why a network round trip and not client-side guessing: only the runtime's directory (via
// `orchestration.agents.get`) can resolve a name to the `agent:<id>` address the write-choke
// RPCs (`orchestration.ask`, `orchestration.threads.create`, …) require — the RPC layer takes
// resolved `agent:<id>` addresses only (s10-2-spec.md:73, "name resolution is CLI-layer sugar").
export async function resolveAgentByNameOrId(
  client: RuntimeClient,
  value: string
): Promise<ResolvedAgentIdentity> {
  const result = await client.call<AgentGetResult>('orchestration.agents.get', nameOrId(value))
  return result.result.agent
}

export function requireNonQuarantined(agent: ResolvedAgentIdentity): ResolvedAgentIdentity {
  if (agent.quarantined) {
    throw new RuntimeClientError(
      'agent_quarantined',
      `Agent ${agent.displayName} is quarantined; showing --id ${agent.id} does not carry a working send address.`
    )
  }
  return agent
}
