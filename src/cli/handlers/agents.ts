import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { getDefaultUserDataPath, RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { resolveEnvironment } from '../runtime/environments'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { nameOrId, resolveAgentAcrossHost } from './agents-shared'
import { addressOf, findAgentsAcrossHosts, LOCAL_FIND_HOST } from './agents-cross-host'

type AgentView = {
  id: string
  displayName: string
  role: string | null
  host: string
  state: 'live' | 'idle' | 'gone'
  derived: boolean
  quarantined: boolean
  title: string | null
  branch: string | null
  worktreePath: string | null
  terminalHandle?: string | null
}

type RegisterResult = { agent: AgentView; created: boolean; reMinted: boolean }
type ListResult = {
  agents: AgentView[]
  liveCount: number
  derivedCount: number
  omitted: { quarantined: number; derived: number }
}
// `addressHost`/`foreign` are CLI-side annotations (S10-4 ruling 3), never part of the RPC
// response itself: a single-host `orchestration.agents.get` result says nothing about which
// saved environment answered it, so `agents show` stamps that in after the call.
type GetResult = { agent: AgentView; pushable: boolean; addressHost: string; foreign: boolean }
// `host`/`foreign` on a plain local find are always `hostIdFor(runtime)`/`false`; `agents find
// --all-hosts` (agents-cross-host.ts) fills them in with the saved-environment alias instead
// (S10-4 ruling 3).
type FindCandidate = {
  id: string
  displayName: string
  role: string | null
  host: string
  state: 'live' | 'idle' | 'gone'
  derived: boolean
  confidence: number
  why: string[]
  terminalHandle?: string | null
  foreign?: boolean
}
type FindResult = {
  outcome: 'resolved' | 'ambiguous' | 'no_match'
  query: string
  threshold: number
  margin: number
  candidates: FindCandidate[]
  omitted?: { quarantined: number; derived: number }
  hostsAnswered?: string
  unreached?: { host: string; reason: string }[]
  malformed?: { host: string; dropped: number }[]
  nextSteps: string[]
}
type RelinkResult = { environment: string; dispatchIds: string[] }

// Why: `agent:<id>` has no reader for a derived (un-registered) row — point the
// sender at the pane's bare handle instead, per FIX derived_agent_unaddressable.
// `quarantined` is optional only for find candidates, which are never quarantined
// (hard-excluded at orchestration-agents-find.ts).
function sendNextStep(agent: {
  id: string
  displayName: string
  derived: boolean
  quarantined?: boolean
  terminalHandle?: string | null
  host?: string
  foreign?: boolean
}): string {
  // Why: never print a working send address for a quarantined row — that is a
  // one-command bypass of the quarantine.
  if (agent.quarantined) {
    return `orca agents show --id ${agent.id}`
  }
  if (agent.foreign && agent.host) {
    // A foreign agent id does not exist in THIS host's directory (S10-4 ruling 12: dispatch
    // --inject to a foreign agent still refuses) — `ask` re-resolves name@host against the peer.
    return `orca agents ask ${addressOf({ displayName: agent.displayName, host: agent.host, foreign: true })} "..."`
  }
  if (agent.derived) {
    return agent.terminalHandle
      ? `orca orchestration send --to ${agent.terminalHandle} --subject "..."`
      : 'orca agents list'
  }
  return `orca orchestration send --to agent:${agent.id} --subject "..."`
}

function agentLine(agent: AgentView): string {
  const namePrefix = agent.derived ? '~' : ''
  const tags = [agent.quarantined ? '[quarantined]' : null].filter(Boolean).join(' ')
  const role = agent.derived ? '' : agent.role ? ` — ${agent.role}` : ''
  return `${namePrefix}${agent.displayName}  [${agent.state}]${role} ${tags}`.trimEnd()
}

function formatAgentRegister(result: RegisterResult): string {
  const verb = result.reMinted ? 'Re-registered' : 'Registered'
  const role = result.agent.role ? ` — role: ${result.agent.role}` : ''
  return (
    `${verb} agent "${result.agent.displayName}" (${result.agent.id})${role}.\n` +
    `Next: orca orchestration send --to agent:${result.agent.id} --subject "..."`
  )
}

function formatAgentsList(result: ListResult): string {
  if (result.agents.length === 0) {
    return 'No agents in the directory yet.\nNext: orca agents register --name <slug> --role "<your role>"'
  }
  const lines = result.agents.map(agentLine)
  const omitted =
    result.omitted.quarantined > 0
      ? `\n(${result.omitted.quarantined} quarantined agent(s) omitted; pass --include-quarantined to see them.)`
      : ''
  return (
    `${lines.join('\n')}${omitted}\n` +
    'Next: orca agents show <name> for details, or orca orchestration send --to agent:<id> --subject "..." (~ names: send --to <bare handle> instead)'
  )
}

function formatAgentGet(result: GetResult): string {
  const a = result.agent
  const suffix = result.foreign ? `@${result.addressHost}` : ''
  return (
    `${a.derived ? '~' : ''}${a.displayName}${suffix} (${a.id}) [${a.state}]${a.role ? ` — ${a.role}` : ''}\n` +
    `Next: ${sendNextStep({ ...a, host: result.addressHost, foreign: result.foreign })}`
  )
}

function candidateLabel(c: FindCandidate): string {
  const suffix = c.foreign ? `@${c.host}` : ''
  return `${c.derived ? '~' : ''}${c.displayName}${suffix}`
}

// S10-4 ruling 3/11: `agents find --all-hosts` stamps `hostsAnswered`/`unreached` on the same
// shape a plain (local-only) find returns — a silent peer never blocks a local resolution, but
// it is never silently dropped either.
function crossHostNote(result: FindResult): string {
  if (result.hostsAnswered === undefined) {
    return ''
  }
  const unreached =
    result.unreached && result.unreached.length > 0
      ? `; unreached: ${result.unreached.map((u) => `${u.host} (${u.reason})`).join(', ')}`
      : ''
  const malformed =
    result.malformed && result.malformed.length > 0
      ? `; dropped: ${result.malformed
          .map((m) => `${m.dropped} unparseable row(s) from ${m.host}`)
          .join(', ')}`
      : ''
  return `\n(hosts answered: ${result.hostsAnswered}${unreached}${malformed})`
}

function formatAgentFind(result: FindResult): string {
  const note = crossHostNote(result)
  if (result.outcome === 'no_match') {
    return `No match for "${result.query}".${note}\nNext: orca agents list`
  }
  const lines = result.candidates.map(
    (c, i) =>
      `  ${i + 1}. ${candidateLabel(c)} (${c.id}) confidence ${c.confidence.toFixed(2)}${c.role ? ` — ${c.role}` : ''}`
  )
  if (result.outcome === 'ambiguous') {
    const first = result.candidates[0]
    const fallback = first
      ? `orca agents show ${first.foreign ? addressOf(first) : `--id ${first.id}`}`
      : 'orca agents list'
    const disambiguate = result.nextSteps[0] ?? fallback
    return (
      `Ambiguous: ${result.candidates.length} candidates match "${result.query}":\n` +
      `${lines.join('\n')}${note}\n` +
      `Next: ${disambiguate}`
    )
  }
  const top = result.candidates[0]
  return (
    `Resolved: ${top ? candidateLabel(top) : ''} (${top?.id}) — confidence ${top?.confidence.toFixed(2)}.${note}\n` +
    `Next: ${top ? sendNextStep(top) : 'orca agents list'}`
  )
}

function formatAgentRelink(result: RelinkResult): string {
  if (result.dispatchIds.length === 0) {
    return `No active federated dispatch on ${result.environment}; nothing to relink.`
  }
  return (
    `Relinked ${result.environment}: reset the relay cursors on ${result.dispatchIds.length} ` +
    `dispatch(es) (${result.dispatchIds.join(', ')}).\n` +
    'Items that arrive from here on are imported under a new relink generation, so their ' +
    "relay_seen outcomes (incl. refusals) never collide with this link's pre-relink history."
  )
}

function formatAgentQuarantine(result: { agent: AgentView }): string {
  const state = result.agent.quarantined ? 'quarantined' : 'unquarantined'
  return (
    `Agent ${result.agent.displayName} (${result.agent.id}) is now ${state}.\n` +
    `Next: orca agents show --id ${result.agent.id}`
  )
}

function formatAgentRetire(result: {
  agent: AgentView
  outcome: 'retired' | 'already_retired'
}): string {
  const verb = result.outcome === 'already_retired' ? 'was already retired' : 'retired'
  return (
    `Agent ${result.agent.displayName} (${result.agent.id}) ${verb}. Its name is free to reclaim.\n` +
    'Next: orca agents list'
  )
}

export const AGENT_HANDLERS: Record<string, CommandHandler> = {
  'agents register': async ({ flags, client, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const role = getOptionalStringFlag(flags, 'role')
    const result = await client.call<RegisterResult>('orchestration.agents.register', {
      name,
      role
    })
    printResult(result, json, formatAgentRegister)
  },
  'agents list': async ({ flags, client, json }) => {
    const limitFlag = getOptionalStringFlag(flags, 'limit')
    const result = await client.call<ListResult>('orchestration.agents.list', {
      state: getOptionalStringFlag(flags, 'state'),
      includeQuarantined: flags.has('include-quarantined') ? true : undefined,
      includeDerived: flags.has('no-derived') ? false : undefined,
      limit: limitFlag ? Number(limitFlag) : undefined
    })
    printResult(result, json, formatAgentsList)
  },
  'agents show': async ({ flags, client, json }) => {
    const positional = getOptionalStringFlag(flags, 'name')
    const id = getOptionalStringFlag(flags, 'id')
    // Why `--id` still wins when both are somehow present (pre-S10-4 precedence, unchanged):
    // only the positional carries `name@host` — `--id` is an id copied off a local `agents
    // list` row, which can never be a foreign one by accident.
    if (!id && positional) {
      const { agent, pushable, host } = await resolveAgentAcrossHost<{
        agent: AgentView
        pushable: boolean
      }>(client, getDefaultUserDataPath(), positional)
      printResult(
        localSuccess({ agent, pushable, addressHost: host, foreign: host !== LOCAL_FIND_HOST }),
        json,
        formatAgentGet
      )
      return
    }
    if (!id) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const result = await client.call<{ agent: AgentView; pushable: boolean }>(
      'orchestration.agents.get',
      { id }
    )
    printResult(
      localSuccess({ ...result.result, addressHost: LOCAL_FIND_HOST, foreign: false }),
      json,
      formatAgentGet
    )
  },
  'agents find': async ({ flags, client, json }) => {
    const query = getRequiredStringFlag(flags, 'query')
    const limitFlag = getOptionalStringFlag(flags, 'limit')
    const limit = limitFlag ? Number(limitFlag) : undefined
    if (flags.has('all-hosts')) {
      const result = await findAgentsAcrossHosts({
        client,
        userDataPath: getDefaultUserDataPath(),
        query,
        limit
      })
      printResult(localSuccess(result), json, formatAgentFind)
      return
    }
    const result = await client.call<FindResult>('orchestration.agents.find', { query, limit })
    printResult(result, json, formatAgentFind)
  },
  'agents relink': async ({ flags, json }) => {
    const environmentSelector = getRequiredStringFlag(flags, 'env')
    const userDataPath = getDefaultUserDataPath()
    const environment = resolveEnvironment(userDataPath, environmentSelector)
    // Why an explicit local client, ignoring any global --environment: relink resets THIS
    // host's own federated_dispatches cursors for a saved environment — always a local-runtime
    // operation, never one to route at a peer via the ordinary environment-selection flag.
    const localClient = new RuntimeClient(userDataPath, undefined, null, null)
    const result = await localClient.call<{ dispatchIds: string[] }>(
      'orchestration.agents.relink',
      { environmentId: environment.id }
    )
    printResult(
      localSuccess({ environment: environment.name, dispatchIds: result.result.dispatchIds }),
      json,
      formatAgentRelink
    )
  },
  'agents quarantine': async ({ flags, client, json }) => {
    const positional = getOptionalStringFlag(flags, 'name')
    const id = getOptionalStringFlag(flags, 'id')
    const target = id ? { id } : positional ? nameOrId(positional) : undefined
    if (!target) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const result = await client.call<{ agent: AgentView }>('orchestration.agents.quarantine', {
      ...target,
      lift: flags.has('lift') ? true : undefined,
      reasonCode: getOptionalStringFlag(flags, 'reason-code')
    })
    printResult(result, json, formatAgentQuarantine)
  },
  'agents retire': async ({ flags, client, json }) => {
    const positional = getOptionalStringFlag(flags, 'name')
    const id = getOptionalStringFlag(flags, 'id')
    const target = id ? { id } : positional ? nameOrId(positional) : undefined
    if (!target) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const result = await client.call<{ agent: AgentView; outcome: 'retired' | 'already_retired' }>(
      'orchestration.agents.retire',
      { ...target, force: flags.has('force') ? true : undefined }
    )
    printResult(result, json, formatAgentRetire)
  }
}

// Why: `agents show`/`agents find --all-hosts`/`agents relink` compute their result locally
// (a merge, or a second RPC call already unwrapped) rather than returning one RPC envelope
// directly — same wrapper as `environment.ts`'s `localSuccess`.
function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}
