// R2 (Ruling 33 Addendum 2, F-20): split out of pact-shared.ts (at its max-lines budget, D-R91)
// - the "one engaged pact per pair" identity-fallback lookup used by
// pact-shared.ts's requireNoEngagedPactWithPeer.
import type Database from '../../sqlite/sync-database'
import { getAgentByIdIncludingTombstoned } from './agent-retire'
import type { ThreadRow } from './types'

// Symmetric (rev 3): matches either id in either column, 'proposed' or 'engaged'.
export function getEngagedPactWith(
  db: Database.Database,
  agentId: string,
  peerAgentId: string
): ThreadRow | undefined {
  const byId = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state IN ('proposed','engaged')
       AND ((pact_proposer_agent_id = ? AND pact_with_agent_id = ?)
         OR (pact_proposer_agent_id = ? AND pact_with_agent_id = ?))`
    )
    .get(agentId, peerAgentId, peerAgentId, agentId) as ThreadRow | undefined
  return byId ?? getEngagedPactWithByIdentity(db, agentId, peerAgentId)
}

type PactIdentity = { hostId: string; displayName: string }

function pactIdentity(db: Database.Database, agentId: string): PactIdentity | undefined {
  const row = getAgentByIdIncludingTombstoned(db, agentId)
  return row ? { hostId: row.host_id, displayName: row.display_name } : undefined
}

function samePactIdentity(a: PactIdentity, b: PactIdentity): boolean {
  return a.hostId === b.hostId && a.displayName === b.displayName
}

// R2 (Ruling 33 Addendum 2, F-20): the id-pair match above stops seeing an engaged pact once a
// party re-registers under a new agents.id (retire + re-register mints a fresh id for the same
// display_name), so the "one engaged pact per pair" guard falls back here to (host_id,
// display_name) identity of both threads' parties, resolved via getAgentByIdIncludingTombstoned
// so a tombstoned predecessor's engaged pact still counts.
function getEngagedPactWithByIdentity(
  db: Database.Database,
  agentId: string,
  peerAgentId: string
): ThreadRow | undefined {
  const caller = pactIdentity(db, agentId)
  const peer = pactIdentity(db, peerAgentId)
  if (!caller || !peer) {
    return undefined
  }
  const candidates = db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state IN ('proposed','engaged')
       AND pact_proposer_agent_id IS NOT NULL AND pact_with_agent_id IS NOT NULL`
    )
    .all() as ThreadRow[]
  return candidates.find((row) => {
    const proposer = pactIdentity(db, row.pact_proposer_agent_id as string)
    const withParty = pactIdentity(db, row.pact_with_agent_id as string)
    if (!proposer || !withParty) {
      return false
    }
    return (
      (samePactIdentity(proposer, caller) && samePactIdentity(withParty, peer)) ||
      (samePactIdentity(proposer, peer) && samePactIdentity(withParty, caller))
    )
  })
}
