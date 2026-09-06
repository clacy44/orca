// S10-21b B14 (design §3.3, errata NB8) — the per-peer-per-window unanswered-proposal park
// block's storage: `agent_rate` via `checkAndBumpRate`, keyed per (peer party key, local agent
// id) rather than per-thread (a peer can re-propose on a different thread against the same local
// agent). Two call sites, deliberately never the same one: a proposal arrival BUMPS the window;
// the local-park-block decision point only READS whether the window is still live, never bumps
// it (a bump-on-every-check would corrupt the window and re-arm the block on every poll).
import type Database from '../../sqlite/sync-database'
import { checkAndBumpRate } from './agent-rate-limit'
import { PACT_PROPOSAL_BLOCK_MS } from './link-binding-constants'

// A closed token, never reused for another rate-limited verb.
const PACT_PROPOSAL_BLOCK_VERB = 'pact_propose_block'

function proposalBlockSubjectKey(peerPartyKey: string, localAgentId: string): string {
  return `${peerPartyKey}::${localAgentId}`
}

// Called at proposal-ARRIVAL time only (the inbound `propose` apply) — bumps the window,
// regardless of the propose's own outcome (§3.3: "a proposal from that (peer, local agent) pair
// bumps the rate window on arrival"). The limit is deliberately unreached in practice (this call
// never itself refuses the propose — the block is enforced only at the park decision, below).
export function bumpProposalBlockWindow(
  db: Database.Database,
  peerPartyKey: string,
  localAgentId: string
): void {
  checkAndBumpRate(db, {
    subjectKey: proposalBlockSubjectKey(peerPartyKey, localAgentId),
    verb: PACT_PROPOSAL_BLOCK_VERB,
    windowMs: PACT_PROPOSAL_BLOCK_MS,
    limit: Number.MAX_SAFE_INTEGER
  })
}

// T-NB8: "the block still applies" even once the ORIGINAL blocking proposal has been answered
// (declined) and a fresh one re-proposed on a DIFFERENT thread — the state must be keyed per
// (peer, local agent), not discoverable only through a currently-unanswered proposal row. This
// enumerates every peer party key with a still-live block window against `localAgentId`, read
// off `agent_rate.subject_key`'s own `<peer>::<localAgentId>` shape (no new table — `agent_rate`
// is already purged whole by `resetAll`, so the block lifts immediately after a reset).
export function proposalBlockingPeerKeys(db: Database.Database, localAgentId: string): string[] {
  const nowMs = Date.now()
  const windowStartMs = Math.floor(nowMs / PACT_PROPOSAL_BLOCK_MS) * PACT_PROPOSAL_BLOCK_MS
  const windowStart = new Date(windowStartMs).toISOString()
  const suffix = `::${localAgentId}`
  const rows = db
    .prepare(
      `SELECT subject_key FROM agent_rate
       WHERE verb = ? AND window_start = ? AND subject_key LIKE ?`
    )
    .all(PACT_PROPOSAL_BLOCK_VERB, windowStart, `%${suffix}`) as { subject_key: string }[]
  return rows
    .filter((r) => r.subject_key.endsWith(suffix))
    .map((r) => r.subject_key.slice(0, r.subject_key.length - suffix.length))
}
