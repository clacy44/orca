// S10-2c: small helpers shared by the `orca agents *` write/read verbs added across
// agents-threads.ts / agents-ask-reply.ts / agents-containment.ts — split out (rather than
// growing agents.ts) to stay under the repo's max-lines ratchet, same precedent as
// orchestration-agents.ts splitting into orchestration-agents-*.ts.
import { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { resolveEnvironment } from '../runtime/environments'
import { LOCAL_FIND_HOST } from './agents-cross-host'

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

export type AgentSelector = { name?: string; id?: string; host: string }

// S10-4 ruling 3 (CLI half): `show`/`ask` accept the `name@host` address `agents find
// --all-hosts` renders back (agents-cross-host.ts's `addressOf`). No `@` (or a trailing/leading
// one, which can't be a host) means local, unchanged.
export function parseAgentSelector(value: string): AgentSelector {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) {
    return { ...nameOrId(value), host: LOCAL_FIND_HOST }
  }
  return { ...nameOrId(value.slice(0, at)), host: value.slice(at + 1) }
}

// Why a fresh client per call rather than reusing the caller's: the caller's `client` is bound
// to whatever `--environment` (if any) the whole invocation targeted, which is orthogonal to a
// `name@host` address naming a *different* saved environment inline. The resolved client is
// handed back too so a follow-up RPC (`orchestration.ask`) on the SAME host does not re-resolve.
// Generic over `orchestration.agents.get`'s full result shape: `agents ask` only needs
// `{ agent: ResolvedAgentIdentity }` (the default), `agents show` wants `{ agent, pushable }`.
export async function resolveAgentAcrossHost<
  TResult extends { agent: unknown } = { agent: ResolvedAgentIdentity }
>(
  client: RuntimeClient,
  userDataPath: string,
  value: string,
  // Why overridable: tests substitute a fake client instead of opening a real connection.
  hostClientFactory: (environmentId: string) => RuntimeClient = (environmentId) =>
    new RuntimeClient(userDataPath, undefined, null, environmentId)
): Promise<TResult & { host: string; client: RuntimeClient }> {
  const selector = parseAgentSelector(value)
  const targetClient =
    selector.host === LOCAL_FIND_HOST
      ? client
      : hostClientFactory(resolveEnvironment(userDataPath, selector.host).id)
  const result = await targetClient.call<TResult>('orchestration.agents.get', {
    name: selector.name,
    id: selector.id
  })
  return { ...result.result, host: selector.host, client: targetClient }
}
