// S10-21a C5 (design v3.2 §2.4; errata 5(p)-5 v2.1): the Layer-2 rebind predicate. Split out of
// agent-restore-rebind.ts to stay under the repo's max-lines ratchet for new source files (<=300).
// Pure reads plus the one budget side effect (checkAndBumpRate, clause 8) — no agents/messages/
// threads writes happen here; those are agent-restore-rebind.ts's job once every clause passes.
import type Database from '../../sqlite/sync-database'
import type { RestoreTicketPayload } from '../restore-ticket-registry'
import type { IncumbentVerdict } from '../incumbent-death'
import { checkAndBumpRate } from './agent-rate-limit'
import type { AgentRow } from './types'

const REBIND_RATE_WINDOW_MS = 60 * 60 * 1000
const REBIND_RATE_LIMIT = 20

export type RebindRefusalReason =
  | 'ticket_stale_generation'
  | 'predecessor_row_not_found'
  | 'row_derived'
  | 'row_tombstoned'
  | 'row_quarantined'
  | 'host_mismatch'
  | 'cross_execution_host'
  | 'incumbent_alive'
  | 'target_leaf_occupied'
  | 'rate_limited'

export type RebindRestoredPaneParams = {
  ticketPayload: RestoreTicketPayload
  newPaneKey: string
  newTerminalHandle: string | null
  hostId: string
  executionHostId: string
  launchGeneration: string
  incumbent: IncumbentVerdict
}

export type RebindPredicateOutcome =
  | { kind: 'refuse'; reason: RebindRefusalReason }
  // Clause 3 / T13: R already sits on the target pane, or a prior call for this exact lineage
  // already committed the move (double fire) — no clause failed, there is simply nothing left
  // to do. Distinguished from a refusal so the caller returns ok:true, not ok:false.
  | { kind: 'noop'; agentId: string }
  | { kind: 'proceed'; row: AgentRow; targetRow: AgentRow | undefined }

// design v3.2 §2.4/agent-directory.ts's own convention: the pane-key SUFFIX (everything after
// the first ':'), never the raw key — a pane moving tabs mints a new tabId prefix but keeps its
// leaf suffix.
export function paneSuffix(paneKey: string): string {
  const idx = paneKey.indexOf(':')
  return idx === -1 ? paneKey : paneKey.slice(idx + 1)
}

// Deliberately UNFILTERED on derived/quarantined/tombstoned_at, unlike agent-directory.ts's
// findByPaneSuffix — clause 4 below is what classifies those states into a typed refusal; a
// filtered lookup would make a tombstoned-but-still-paneKeyed row read as "not found" (clause 2)
// instead of the specific reason clause 4 names. Rows a bare `retireAgent` already nulled
// pane_key for are structurally unreachable here (§8.4's own limitation, not something this
// predicate can recover — see the RETURN block's open question on `T.agentId`).
function findRowByPaneSuffix(
  db: Database.Database,
  hostId: string,
  paneKey: string
): AgentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND pane_key IS NOT NULL
         AND substr(pane_key, instr(pane_key, ':') + 1) = ?`
    )
    .get(hostId, paneSuffix(paneKey)) as AgentRow | undefined
}

// T13 fallback: the predecessor-suffix lookup above only finds R while it still sits on the
// predecessor pane. After a first successful rebind, R.pane_key IS the new pane, so a second
// call for the SAME lineage (same predecessorPaneKey/newPaneKey pair) must be recognised by
// looking at the target instead — a non-derived row already sitting there whose newest 'rebind'
// audit row cites this exact predecessor pane is the earlier commit, not a fresh claim.
function findAlreadyRebound(
  db: Database.Database,
  hostId: string,
  predecessorPaneKey: string,
  newPaneKey: string
): AgentRow | undefined {
  const candidate = findRowByPaneSuffix(db, hostId, newPaneKey)
  if (!candidate || candidate.derived === 1) {
    return undefined
  }
  const marker = db
    .prepare(
      `SELECT 1 FROM agent_audit
       WHERE agent_id = ? AND verb = 'rebind' AND outcome = 'reminted'
         AND reason_code LIKE ?
       ORDER BY seq DESC LIMIT 1`
    )
    .get(candidate.id, `%${predecessorPaneKey} -> ${newPaneKey}%`)
  return marker ? candidate : undefined
}

/** §2.4's numbered predicate, clauses 1-8, evaluated in order; the first violated clause is the
 * refusal reason. Clause 1's ticket unexpired/unredeemed sub-conditions are the CALLER's
 * responsibility (C5 never touches RestoreTicketRegistry, per SCOPE) — only the "minted in this
 * runtime generation" sub-condition is checked here, via `ticketPayload.launchGeneration` versus
 * the current `launchGeneration`. */
export function evaluateRebindPredicate(
  db: Database.Database,
  params: RebindRestoredPaneParams
): RebindPredicateOutcome {
  // Clause 1 (partial — see docstring).
  if (params.ticketPayload.launchGeneration !== params.launchGeneration) {
    return { kind: 'refuse', reason: 'ticket_stale_generation' }
  }

  const row = findRowByPaneSuffix(db, params.hostId, params.ticketPayload.predecessorPaneKey)
  if (!row) {
    const already = findAlreadyRebound(
      db,
      params.hostId,
      params.ticketPayload.predecessorPaneKey,
      params.newPaneKey
    )
    if (already) {
      return { kind: 'noop', agentId: already.id }
    }
    return { kind: 'refuse', reason: 'predecessor_row_not_found' }
  }

  // Clause 3: Layer 1 already preserved the pane (or this is the pane it already moved to) —
  // nothing to do. Defensive; `row` was found BY the predecessor suffix so this fires only when
  // predecessor and new suffixes coincide.
  if (paneSuffix(row.pane_key as string) === paneSuffix(params.newPaneKey)) {
    return { kind: 'noop', agentId: row.id }
  }

  // Clause 4.
  if (row.derived === 1) {
    return { kind: 'refuse', reason: 'row_derived' }
  }
  if (row.tombstoned_at !== null) {
    return { kind: 'refuse', reason: 'row_tombstoned' }
  }
  if (row.quarantined === 1) {
    return { kind: 'refuse', reason: 'row_quarantined' }
  }

  // Clause 5.
  if (row.host_id !== params.hostId) {
    return { kind: 'refuse', reason: 'host_mismatch' }
  }
  if (params.ticketPayload.executionHostId !== params.executionHostId) {
    return { kind: 'refuse', reason: 'cross_execution_host' }
  }

  // Clause 6.
  if (!params.incumbent.dead) {
    return { kind: 'refuse', reason: 'incumbent_alive' }
  }

  // Clause 7.
  const targetRow = findRowByPaneSuffix(db, params.hostId, params.newPaneKey)
  if (targetRow && !(targetRow.derived === 1 && targetRow.quarantined === 0)) {
    return { kind: 'refuse', reason: 'target_leaf_occupied' }
  }

  // Clause 8.
  const rate = checkAndBumpRate(db, {
    subjectKey: row.id,
    verb: 'rebind',
    windowMs: REBIND_RATE_WINDOW_MS,
    limit: REBIND_RATE_LIMIT
  })
  if (!rate.allowed) {
    return { kind: 'refuse', reason: 'rate_limited' }
  }

  return { kind: 'proceed', row, targetRow }
}
