// S10-3 pact spec — read paths: getPactState, getTurnsHeldBy, getPactLedger.
// getEngagedPactWith lives in pact-shared.ts (shared with proposePact's own guard).
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
// (rev 4). Ordering (seq/thread id) is not meaningful; callers print every entry.
export function getTurnsHeldBy(db: Database.Database, agentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM threads WHERE purged_at IS NULL AND pact_state = 'engaged'
       AND pact_paused_at IS NULL AND pact_turn_agent_id = ?`
    )
    .all(agentId) as { id: string }[]
  return rows.map((r) => r.id)
}

type PactStepQueryRow = {
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
      `SELECT ps.ordinal, ps.kind, ps.actor_agent_id, a.display_name AS actor_display_name,
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
    // Only a row that actually carries a summary can be withheld — propose/accept/decline/
    // pause/resume/release rows never have one, so a quarantined proposer's `propose` row isn't
    // double-counted alongside their real (summary-bearing) `step` rows.
    const withheld = !purged && row.summary !== null && row.actor_quarantined === 1
    if (purged) {
      purgedCount++
    }
    if (withheld) {
      withheldCount++
    }
    return {
      ordinal: row.ordinal,
      kind: row.kind,
      actorAgentId: row.actor_agent_id,
      actorDisplayName: row.actor_display_name,
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
