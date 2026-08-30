import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

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
type GetResult = { agent: AgentView; pushable: boolean }
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
}
type FindResult = {
  outcome: 'resolved' | 'ambiguous' | 'no_match'
  query: string
  threshold: number
  margin: number
  candidates: FindCandidate[]
  omitted: { quarantined: number; derived: number }
  nextSteps: string[]
}

// Why: `agents show <name|id>` and `agents quarantine <name|id>` take one positional that can
// be either — id is the only shape a display_name (ASCII slug, no underscore) can never take.
function nameOrId(value: string): { name?: string; id?: string } {
  return value.startsWith('agt_') ? { id: value } : { name: value }
}

// Why: `agent:<id>` has no reader for a derived (un-registered) row — point the
// sender at the pane's bare handle instead, per FIX derived_agent_unaddressable.
function sendNextStep(agent: {
  id: string
  derived: boolean
  terminalHandle?: string | null
}): string {
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
  return (
    `${a.derived ? '~' : ''}${a.displayName} (${a.id}) [${a.state}]${a.role ? ` — ${a.role}` : ''}\n` +
    `Next: ${sendNextStep(a)}`
  )
}

function formatAgentFind(result: FindResult): string {
  if (result.outcome === 'no_match') {
    return `No match for "${result.query}".\nNext: orca agents list`
  }
  const lines = result.candidates.map(
    (c, i) =>
      `  ${i + 1}. ${c.derived ? '~' : ''}${c.displayName} (${c.id}) confidence ${c.confidence.toFixed(2)}${c.role ? ` — ${c.role}` : ''}`
  )
  if (result.outcome === 'ambiguous') {
    const disambiguate = result.nextSteps[0] ?? `orca agents show --id ${result.candidates[0]?.id}`
    return (
      `Ambiguous: ${result.candidates.length} candidates match "${result.query}":\n` +
      `${lines.join('\n')}\n` +
      `Next: ${disambiguate}`
    )
  }
  const top = result.candidates[0]
  return (
    `Resolved: ${top?.derived ? '~' : ''}${top?.displayName} (${top?.id}) — confidence ${top?.confidence.toFixed(2)}.\n` +
    `Next: ${top ? sendNextStep(top) : 'orca agents list'}`
  )
}

function formatAgentQuarantine(result: { agent: AgentView }): string {
  const state = result.agent.quarantined ? 'quarantined' : 'unquarantined'
  return (
    `Agent ${result.agent.displayName} (${result.agent.id}) is now ${state}.\n` +
    `Next: orca agents show --id ${result.agent.id}`
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
    const target = id ? { id } : positional ? nameOrId(positional) : undefined
    if (!target) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const result = await client.call<GetResult>('orchestration.agents.get', target)
    printResult(result, json, formatAgentGet)
  },
  'agents find': async ({ flags, client, json }) => {
    const query = getRequiredStringFlag(flags, 'query')
    const limitFlag = getOptionalStringFlag(flags, 'limit')
    const result = await client.call<FindResult>('orchestration.agents.find', {
      query,
      limit: limitFlag ? Number(limitFlag) : undefined
    })
    printResult(result, json, formatAgentFind)
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
  }
}
