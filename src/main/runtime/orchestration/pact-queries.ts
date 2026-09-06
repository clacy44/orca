// S10-3 pact spec — read paths: getPactState, getTurnsHeldBy, getPactLedger.
// getEngagedPactWith lives in pact-pair-identity.ts (shared with proposePact's own guard).
// Split out per the max-lines ratchet.
import type Database from '../../sqlite/sync-database'
import type { PactLedgerEntry, PactLedgerResult, PactStepKind } from './pact-types'
import type { ThreadRow } from './types'

export function getPactState(db: Database.Database, threadId: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ? AND purged_at IS NULL').get(threadId) as
    | ThreadRow
    | undefined
}

// K23 (proposal ring, answer_first): any pact where `agentId` is the addressee of an
// unanswered PROPOSAL. Not scoped to a particular thread — the caller owes an answer regardless
// of which thread they try to park `wait --for pact` on.
export function getIncomingUnansweredProposal(
  db: Database.Database,
  agentId: string
): ThreadRow | undefined {
  return db
    .prepare(
      `SELECT * FROM threads WHERE purged_at IS NULL AND pact_state = 'proposed' AND pact_with_agent_id = ?
       ORDER BY pact_at ASC LIMIT 1`
    )
    .get(agentId) as ThreadRow | undefined
}

// K5/K24: a paused pact's turn is frozen — excluded here so its holder may park elsewhere
// (rev 4). S10-21b B6 (design §2.1/§2.9, T26): a thread with `pact_turn_in_flight_at IS NOT
// NULL` is ALSO excluded — the emitting host still shows the turn as its own during the
// in-flight interval (§2.2's INV-P-021 transient (i)), so counting it here would let the
// emitter park a `wait --for step` on a turn it just handed away, alongside the peer who has
// already advanced it — exactly the double-count INV-P-021 forbids outside the two named
// transients. Ordering (seq/thread id) is not meaningful; callers print every entry.
export function getTurnsHeldBy(db: Database.Database, agentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NULL AND pact_turn_in_flight_at IS NULL AND pact_turn_agent_id = ?`
    )
    .all(agentId) as { id: string }[]
  return rows.map((r) => r.id)
}

type PactStepQueryRow = {
  era: number
  ordinal: number
  kind: PactStepKind
  actor_agent_id: string | null
  actor_display_name: string | null
  actor_quarantined: number | null
  at: string
  summary: string | null
  summary_sha256: string
  summary_purged_at: string | null
  reason_code: string | null
}

export type GetPactLedgerParams = {
  threadId: string
  // Computed by the RPC layer (ruling 3): the two pact participants, and a local non-federated
  // caller — never derived here from agent identity, which this db-level function does not see.
  revealSummaries: boolean
  // S10-21b B11 (design §4.7, T31): resolves a remote actor's rendered party key
  // (`remote:<link>:<remoteAgentId>`, B8 batch-2 review item 3) to a display name and a
  // supersession-chain-wide quarantine verdict. Supplied only by OrchestrationDb.getPactLedger
  // (db.ts), which alone holds the class methods this needs (`walkRemoteAgentSupersessionChain`,
  // `isRemoteAgentLocallyQuarantined`) — this free function only ever takes a raw
  // `Database.Database` handle (this file's standing shape) and never calls them directly.
  // Optional so every pre-B11 direct caller of this function (pact-queries.test.ts) stays
  // byte-identical.
  resolveRemoteActor?: (
    renderedKey: string
  ) => { displayName: string | null; quarantined: boolean } | null
}

// Ruling 3: the skeleton (ordinal/actor/kind/timestamp/hash prefix) is unconditional for any
// thread participant — visibility gating for THAT is the RPC layer's job (not_a_participant).
// Summary withholding (quarantine, read-time only per rev 3) and purge tombstoning happen here,
// in SQL, never in a renderer — an ordinal is never elided (ruling 2).
export function getPactLedger(
  db: Database.Database,
  params: GetPactLedgerParams
): PactLedgerResult {
  const rows = db
    .prepare(
      `SELECT ps.pact_era AS era, ps.ordinal, ps.kind, ps.actor_agent_id, a.display_name AS actor_display_name,
              a.quarantined AS actor_quarantined, ps.at, ps.summary, ps.summary_sha256,
              ps.summary_purged_at, ps.reason_code
       FROM pact_steps ps
       LEFT JOIN agents a ON a.id = ps.actor_agent_id
       WHERE ps.thread_id = ?
       ORDER BY ps.seq ASC`
    )
    .all(params.threadId) as PactStepQueryRow[]

  let purgedCount = 0
  let withheldCount = 0
  const entries: PactLedgerEntry[] = rows.map((row) => {
    const purged = row.summary_purged_at !== null
    // S10-21b B11: `ps.actor_agent_id` for a remote actor is the RENDERED party key
    // (`remote:<link>:<remoteAgentId>`), which never matches `agents.id` — the LEFT JOIN above
    // always misses it, leaving `actor_display_name`/`actor_quarantined` null for every remote
    // author. Resolve through the caller-supplied accessor instead; a local actor (or a caller
    // that passed no resolver) falls through to the join's own columns unchanged.
    const isRemoteActor = row.actor_agent_id !== null && row.actor_agent_id.startsWith('remote:')
    const remote =
      isRemoteActor && params.resolveRemoteActor
        ? params.resolveRemoteActor(row.actor_agent_id as string)
        : null
    const actorDisplayName = remote ? remote.displayName : row.actor_display_name
    const actorQuarantined = remote ? remote.quarantined : row.actor_quarantined === 1
    // Only a row that actually carries a summary can be withheld — propose/accept/decline/
    // pause/resume/release rows never have one, so a quarantined proposer's `propose` row isn't
    // double-counted alongside their real (summary-bearing) `step` rows.
    const withheld = !purged && row.summary !== null && actorQuarantined
    if (purged) {
      purgedCount++
    }
    if (withheld) {
      withheldCount++
    }
    return {
      era: row.era,
      ordinal: row.ordinal,
      kind: row.kind,
      actorAgentId: row.actor_agent_id,
      actorDisplayName,
      at: row.at,
      summary: params.revealSummaries && !purged && !withheld ? row.summary : null,
      summaryShaPrefix: row.summary_sha256 ? row.summary_sha256.slice(0, 12) : null,
      withheld,
      purged,
      reasonCode: row.reason_code
    }
  })
  return { entries, omitted: { purged: purgedCount, withheld: withheldCount } }
}
