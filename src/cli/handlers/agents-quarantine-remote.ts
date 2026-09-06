// S10-21b B16b (design §4.7, §7): the CLI half of `orca agents quarantine <name>@<host>` —
// split from agents.ts (max-lines ratchet), same precedent as agents-containment.ts. Never
// resolves the peer live: the RPC (`orchestration.agents.quarantineRemote`) reads only this
// host's own mirror, so a quarantine works even against an unreachable/hostile peer.
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import type { HandlerContext } from '../dispatch'
import type { AgentSelector } from './agents-shared'

type QuarantineRemoteResult = {
  remoteAgent: { id: string; displayName: string; host: string; quarantined: boolean }
  chainLength: number
}

function formatAgentQuarantineRemote(result: QuarantineRemoteResult): string {
  const { remoteAgent } = result
  const state = remoteAgent.quarantined ? 'quarantined' : 'unquarantined'
  const chainNote =
    result.chainLength > 1 ? ` (${result.chainLength} superseded id(s) in its chain)` : ''
  return (
    `Remote agent ${remoteAgent.displayName}@${remoteAgent.host} is now ${state}${chainNote}.\n` +
    `Next: orca agents pact --with ${remoteAgent.displayName}@${remoteAgent.host} --on <thread>`
  )
}

export async function quarantineRemoteAgent(
  { flags, client, json }: HandlerContext,
  selector: AgentSelector
): Promise<void> {
  const result = await client.call<QuarantineRemoteResult>(
    'orchestration.agents.quarantineRemote',
    {
      name: selector.name,
      id: selector.id,
      host: selector.host,
      lift: flags.has('lift') ? true : undefined,
      reasonCode: getOptionalStringFlag(flags, 'reason-code')
    }
  )
  printResult(result, json, formatAgentQuarantineRemote)
}
