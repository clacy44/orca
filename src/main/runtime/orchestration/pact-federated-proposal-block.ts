// S10-21b B14 (design §3.3, errata NB8) — the per-peer-per-window unanswered-proposal park
// block's storage: `agent_rate`, keyed per (peer party key, local agent id) rather than
// per-thread (a peer can re-propose on a different thread against the same local agent). Two
// call sites, deliberately never the same one: a proposal arrival BUMPS the window (starts it
// if none is live; leaves an already-live window untouched — §3.3: "one still inside an
// unexpired window does not extend it"); the local-park-block decision point only READS whether
// the CURRENT incoming proposal is a re-propose inside an already-established window, never
// bumps.
//
// S10-21b B17 (D-R137 F1/F14, D-R138 F1/F10): the base implementation floored `window_start` to
// a tumbling `PACT_PROPOSAL_BLOCK_MS` bucket (a proposal at :59 blocked for one minute, one at
// :01 for fifty-nine) and threw on the window's mere existence regardless of whether any
// proposal was still unanswered — a peer who was already answered could leave the local chair
// permanently refused `answer_first` until the bucket rolled. Storage is now a genuinely SLIDING
// window (`window_start` is the real arrival timestamp of the window-establishing proposal, not
// a floored bucket) and the read side (`isProposalReArmSuppressed`) never causes a throw by
// itself — see orchestration-wait.ts's `assertNoIncomingProposalOwed`.
import type Database from '../../sqlite/sync-database'
import { PACT_PROPOSAL_BLOCK_MS } from './link-binding-constants'

// A closed token, never reused for another rate-limited verb.
const PACT_PROPOSAL_BLOCK_VERB = 'pact_propose_block'

export function proposalBlockSubjectKey(peerPartyKey: string, localAgentId: string): string {
  return `${peerPartyKey}::${localAgentId}`
}

type BlockWindowRow = { window_start: string; count: number }

function readWindowRow(db: Database.Database, subjectKey: string): BlockWindowRow | undefined {
  return db
    .prepare(`SELECT window_start, count FROM agent_rate WHERE subject_key = ? AND verb = ?`)
    .get(subjectKey, PACT_PROPOSAL_BLOCK_VERB) as BlockWindowRow | undefined
}

function windowLive(row: Pick<BlockWindowRow, 'window_start'> | undefined, nowMs: number): boolean {
  if (!row) {
    return false
  }
  return nowMs - Date.parse(row.window_start) < PACT_PROPOSAL_BLOCK_MS
}

// Called at proposal-ARRIVAL time only (the inbound `propose` apply) — regardless of the
// propose's own outcome (§3.3: "a proposal from that (peer, local agent) pair bumps the rate
// window on arrival"). If a window is already live for this (peer, local agent) pair, this
// arrival is counted (marking it as a re-propose the window is designed to suppress at read
// time) but `window_start` is left untouched — the window is the peer's blocking BUDGET, not
// the proposal's own lifetime, and re-proposing inside it must not extend it. If no window is
// live (first-ever proposal from this peer, or the prior window has fully elapsed), this
// arrival starts a fresh window and IS the window-establishing proposal (count = 1) — the one
// case the read side still treats as a genuine, blocking, unanswered proposal.
export function bumpProposalBlockWindow(
  db: Database.Database,
  peerPartyKey: string,
  localAgentId: string
): void {
  const subjectKey = proposalBlockSubjectKey(peerPartyKey, localAgentId)
  const nowMs = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = readWindowRow(db, subjectKey)
    if (windowLive(row, nowMs)) {
      db.prepare(
        `UPDATE agent_rate SET count = count + 1
         WHERE subject_key = ? AND verb = ? AND window_start = ?`
      ).run(subjectKey, PACT_PROPOSAL_BLOCK_VERB, row!.window_start)
    } else {
      db.prepare(`DELETE FROM agent_rate WHERE subject_key = ? AND verb = ?`).run(
        subjectKey,
        PACT_PROPOSAL_BLOCK_VERB
      )
      db.prepare(
        `INSERT INTO agent_rate (subject_key, verb, window_start, count) VALUES (?, ?, ?, 1)`
      ).run(subjectKey, PACT_PROPOSAL_BLOCK_VERB, new Date(nowMs).toISOString())
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// S10-21b B17 (D-R137 F1/F14, D-R138 F1/F10): read-only "is the CALLER'S CURRENT incoming
// unanswered proposal from this peer merely a re-propose inside an already-established window"
// check — never bumps. True only when a live window exists for (peerPartyKey, localAgentId) AND
// at least one arrival has landed since the window-establishing proposal (count >= 2), i.e. the
// window was already live before this incoming proposal arrived, so it cannot be the one that
// established it. The window-establishing proposal itself (count === 1) still blocks normally;
// once the window fully elapses the stored row is stale (`windowLive` is false) and this
// returns false — the block re-arms, exactly as §3.3's closing sentence requires.
//
// D-R139 N3 was investigated and NOT applied — see this commit's body for the contradiction.
export function isProposalReArmSuppressed(
  db: Database.Database,
  peerPartyKey: string,
  localAgentId: string
): boolean {
  const subjectKey = proposalBlockSubjectKey(peerPartyKey, localAgentId)
  const nowMs = Date.now()
  const row = readWindowRow(db, subjectKey)
  return windowLive(row, nowMs) && (row?.count ?? 0) >= 2
}

// T-NB8 (retained): every peer party key with a currently-live block window against
// `localAgentId`, regardless of count — used only for observability (`pact --show` /
// `orchestration check`) and by `resetAll`'s "the block lifts immediately" test. Never consulted
// by the wait guard itself (D-R137 F1: consulting mere liveness there was the bug).
export function proposalBlockingPeerKeys(db: Database.Database, localAgentId: string): string[] {
  const nowMs = Date.now()
  const suffix = `::${localAgentId}`
  const rows = db
    .prepare(
      `SELECT subject_key, window_start FROM agent_rate WHERE verb = ? AND subject_key LIKE ?`
    )
    .all(PACT_PROPOSAL_BLOCK_VERB, `%${suffix}`) as { subject_key: string; window_start: string }[]
  return rows
    .filter((r) => r.subject_key.endsWith(suffix) && windowLive(r, nowMs))
    .map((r) => r.subject_key.slice(0, r.subject_key.length - suffix.length))
}
