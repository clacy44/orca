import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { launchTokenHash } from '../../shared/launch-token-hash'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

export type InternalCreateOrAttachOptions = CreateOrAttachOptions & {
  agentSessionGeneration?: string
}

export async function createOrAttachClaimedAgentSession(args: {
  options: CreateOrAttachOptions
  owners: ClaimedAgentPtyOwnerRegistry
  isLive: (owner: AgentSessionOwnerBinding) => boolean
  createOrAttach: (options: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>
}): Promise<CreateOrAttachResult> {
  const ensureRequest = args.options.agentSessionEnsure
  if (!ensureRequest) {
    return await args.createOrAttach(args.options)
  }
  let created: CreateOrAttachResult | null = null
  const envLaunchToken = args.options.env?.ORCA_AGENT_LAUNCH_TOKEN
  const ensured = await args.owners.ensure({
    claim: ensureRequest.claim,
    surface: ensureRequest.surface,
    ...(envLaunchToken ? { launchTokenHash: launchTokenHash(envLaunchToken) } : {}),
    spawn: async ({ generation }) => {
      created = await args.createOrAttach({
        ...args.options,
        agentSessionGeneration: generation
      })
      return { ptyId: args.options.sessionId }
    },
    isLive: args.isLive
  })
  if (ensured.disposition === 'created' && created) {
    return { ...(created as CreateOrAttachResult), agentSessionEnsure: ensured }
  }
  const adopted = await args.createOrAttach({
    ...args.options,
    sessionId: ensured.owner.ptyId,
    command: undefined,
    agentSessionEnsure: undefined,
    attachOnly: true
  })
  return { ...adopted, agentSessionEnsure: ensured }
}
