// Split out of pact-federated-emit.ts (max-lines ratchet, S10-21b B15): the outbound envelope
// this pump sends (orchestration-reply-foreign.ts's mail-literal shape, `pact: wirePact`
// attached) plus the fromAgent identity lookup it embeds. Behaviour unchanged from B6/B9c —
// `wirePact` itself is byte-identical to before this split; see 21b-D1's comment (git blame)
// for the full history of why the envelope carries toAgentId/messageId/subject at top level.
import type Database from '../../sqlite/sync-database'
import { getAgentById } from './agent-directory'
import type { FederatedSenderIdentity } from './federated-sender-identity'
import type { FederatedPactResyncPayload } from './pact-federated-emit'

function buildFederatedSenderIdentityFromRawDb(
  db: Database.Database,
  actorAgentId: string
): FederatedSenderIdentity | undefined {
  const row = getAgentById(db, actorAgentId)
  if (!row) {
    return undefined
  }
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    quarantined: row.quarantined === 1
  }
}

export function buildPactWirePayload(
  db: Database.Database,
  params: {
    actorAgentId: string | null
    verb: string
    seq: number
    era: number
    peerAgentId: string
    threadId: string
    subject: string
    messageId: string
    stepsTotal?: number | null
    wireOrdinal?: number
    reasonCode?: string | null
    rebind?: { oldAgentId: string }
    resyncRequest?: { nonce: string }
    resync?: FederatedPactResyncPayload
  }
): string {
  const wirePact: Record<string, unknown> = { verb: params.verb, seq: params.seq, era: params.era }
  if (params.stepsTotal !== undefined) {
    wirePact.stepsTotal = params.stepsTotal
  }
  if (params.wireOrdinal !== undefined) {
    wirePact.ordinal = params.wireOrdinal
  }
  if (params.reasonCode !== undefined) {
    wirePact.reasonCode = params.reasonCode
  }
  if (params.rebind !== undefined) {
    wirePact.rebind = params.rebind
  }
  if (params.resyncRequest !== undefined) {
    wirePact.resyncRequest = params.resyncRequest
  }
  if (params.resync !== undefined) {
    wirePact.resync = params.resync
  }
  const fromAgent = params.actorAgentId
    ? buildFederatedSenderIdentityFromRawDb(db, params.actorAgentId)
    : undefined
  const envelope: Record<string, unknown> = {
    ...(fromAgent ? { fromAgent } : {}),
    toAgentId: params.peerAgentId,
    messageId: params.messageId,
    threadId: params.threadId,
    subject: params.subject,
    type: 'status',
    priority: 'normal',
    pact: wirePact
  }
  return JSON.stringify(envelope)
}
