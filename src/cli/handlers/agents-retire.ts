// S10-7 F-B: `orca agents retire` — split out of agents.ts to stay under the max-lines ratchet,
// same precedent as agents-containment.ts.
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { nameOrId } from './agents-shared'
import type { AgentView } from './agents'

type RetireResult = { agent: AgentView; outcome: 'retired' | 'already_retired' }

function formatAgentRetire(result: RetireResult): string {
  const verb = result.outcome === 'already_retired' ? 'was already retired' : 'retired'
  return (
    `Agent ${result.agent.displayName} (${result.agent.id}) ${verb}. Its name is free to reclaim.\n` +
    'Next: orca agents list'
  )
}

export const AGENT_RETIRE_HANDLERS: Record<string, CommandHandler> = {
  'agents retire': async ({ flags, client, json }) => {
    const positional = getOptionalStringFlag(flags, 'name')
    const id = getOptionalStringFlag(flags, 'id')
    const target = id ? { id } : positional ? nameOrId(positional) : undefined
    if (!target) {
      throw new RuntimeClientError('invalid_argument', 'Pass an agent name or id.')
    }
    const result = await client.call<RetireResult>('orchestration.agents.retire', {
      ...target,
      force: flags.has('force') ? true : undefined
    })
    printResult(result, json, formatAgentRetire)
  }
}
