// S10-21a C5 (design v3.2 §2.4; errata 5(p)-5 v2.1): the Layer-2 rebind predicate. Split out of
// agent-restore-rebind.ts to stay under the repo's max-lines ratchet for new source files (<=300).
// Pure reads plus the one budget side effect (checkAndBumpRate, clause 8) — no agents/messages/
// threads writes happen here; those are agent-restore-rebind.ts's job once every clause passes.
import type Database from '../../sqlite/sync-database'
import type { RestoreTicketPayload } from '../restore-ticket-registry'
import type { IncumbentVerdict } from '../incumbent-death'
import { checkAndBumpRate } from './agent-rate-limit'
import type { AgentLaunchSessionRow } from './agent-launch-sessions'
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
  // [S10-21a C5b, errata 5(z)/5(aa)-5, D-R107 HIGH-1] The ticket's own launchSeq snapshot no
  // longer matches: either the referenced agent_launch_sessions row's pane_key has drifted from
  // the ticket's predecessorPaneKey, or its agent_id names a DIFFERENT agent than the row found
  // by pane suffix — a different registered identity took the suffix since the ticket was
  // minted. Distinguished from `predecessor_row_not_found` (no launch row at all for the
  // seq) — this is a genuine identity contest, audited `outcome: 'contested'`, same as
  // `incumbent_alive`.
  | 'predecessor_moved'
  // [Ruling 34 Addendum 16] The launch-row write (recordLaunchInTransaction, inside this
  // function's own transaction) hit a genuine cross-pane collision — a different pane already
  // holds this session id. Rolls back the whole rebind, not just the launch row.
  | 'launch_row_foreign_session_id'
  // [S10-21a C5b, Ruling 34 Addendum 18(v)] Step 5's launch-row write came back `restated`
  // (idempotent — a row already existed for this exact session/evidence/pane) but did NOT match
  // the shape of "the row the admission wrote at spawn for this restore" — refused rather than
  // silently binding agent_id to an unrelated row. Checked in agent-restore-rebind.ts, not here;
  // kept in this same union for the same reason `launch_row_foreign_session_id` already is.
  | 'launch_row_restated_mismatch'

export type RebindRestoredPaneParams = {
  ticketPayload: RestoreTicketPayload
  newPaneKey: string
  newTerminalHandle: string | null
  hostId: string
  executionHostId: string
  launchGeneration: string
  incumbent: IncumbentVerdict
  // [Ruling 34 Addendum 16] Optional: the agents table carries this column and the runtime can
  // supply a value (`runtime.getTerminalProcessIncarnation(newTerminalHandle)`, same source
  // agent-directory-rpc-liveness.ts's RPC layer already reads for every other liveness/refresh
  // path), but C5 itself is pure DB and has no runtime handle — so the caller (C7) threads it
  // through. Undefined leaves the column untouched; a caller that has no value should simply
  // omit this rather than invent one.
  processIncarnation?: string | null
}

export type RebindPredicateOutcome =
  | {
      kind: 'refuse'
      reason: RebindRefusalReason
      // [S10-21a C6/C5b, §2.6, D-R107] Set for the two refusals that are also contested-lineage
      // events — 'incumbent_alive' and 'predecessor_moved' — so the caller can attribute the
      // `contested` audit row to R without a second lookup. Every other refusal reason leaves
      // this undefined (it still audits, just under `outcome: 'refused'`, with agentId: null).
      agentId?: string
    }
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
// instead of the specific reason clause 4 names. [Ruling 34 Addendum 16(a)] A row a bare
// `retireAgent` already nulled pane_key for is structurally unreachable by this lookup — RULED:
// this is the correct refusal (the pane key IS identity, §1.1), not a gap to fix. It surfaces as
// `predecessor_row_not_found` below, same as any other unresolvable predecessor.
// [S10-21a C5b, D-R107 LOW-3] idx_agents_pane_suffix's own UNIQUE excludes tombstoned rows
// (its WHERE clause), so a live row and a tombstoned-but-still-pane-keyed row CAN legally
// coexist on the same suffix for a narrow window — the un-ORDERed `.get()` this replaces picked
// whichever SQLite happened to return first. ORDER BY prefers the live (tombstoned_at IS NULL)
// row when both exist, WITHOUT filtering the tombstoned one out entirely — a filtered lookup
// would make it read as "not found" (clause 2) instead of the specific `row_tombstoned` reason
// clause 4 names (Addendum 16(a)'s own reasoning for staying unfiltered).
function findRowByPaneSuffix(
  db: Database.Database,
  hostId: string,
  paneKey: string
): AgentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agents
       WHERE host_id = ? AND pane_key IS NOT NULL
         AND substr(pane_key, instr(pane_key, ':') + 1) = ?
       ORDER BY (tombstoned_at IS NULL) DESC
       LIMIT 1`
    )
    .get(hostId, paneSuffix(paneKey)) as AgentRow | undefined
}

// [S10-21a C5b, D-R107 LOW-2] SQLite LIKE has no default escape character — a pane key
// containing '%' or '_' would otherwise widen the pattern findAlreadyRebound matches against.
// No schema change available (structured column ruled out by the standing "no schema change"
// constraint); ESCAPE '\' plus escaping the pattern's own literal wildcards is the fix.
function escapeLikeWildcards(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
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
         AND reason_code LIKE ? ESCAPE '\\'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(
      candidate.id,
      `%${escapeLikeWildcards(predecessorPaneKey)} -> ${escapeLikeWildcards(newPaneKey)}%`
    )
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

  // Clause 2 extension [S10-21a C5b, errata 5(z)/5(aa)-5, D-R107 HIGH-1]: the pane-suffix
  // lookup above accepts WHATEVER row occupies suffix(predecessorPaneKey) right now — a
  // different registered agent could have claimed that suffix since the ticket was minted, and
  // clause 3's coincide-check cannot catch it (it only compares pane suffixes, never identity).
  // ticketPayload.launchSeq (optional — older/synthetic tickets omit it, and this whole check is
  // skipped when absent, matching every existing caller unchanged) names the EXACT
  // agent_launch_sessions row the sweep read at mint time; its own `pane_key` must still equal
  // the ticket's `predecessorPaneKey`, and its `agent_id` (once set) must equal `row.id` — either
  // mismatch means "the row moved" (5(z)'s framing), refused as a genuine identity contest.
  if (params.ticketPayload.launchSeq !== undefined) {
    const launchRow = db
      .prepare(`SELECT * FROM agent_launch_sessions WHERE seq = ?`)
      .get(params.ticketPayload.launchSeq) as AgentLaunchSessionRow | undefined
    if (!launchRow) {
      return { kind: 'refuse', reason: 'predecessor_row_not_found' }
    }
    const paneDrifted = launchRow.pane_key !== params.ticketPayload.predecessorPaneKey
    const identityDiffers = launchRow.agent_id !== null && launchRow.agent_id !== row.id
    if (paneDrifted || identityDiffers) {
      return { kind: 'refuse', reason: 'predecessor_moved', agentId: row.id }
    }
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

  // Clause 6. [S10-21a C6, §2.6] Contested lineage: a live incumbent still holds this row's
  // lineage. `agentId` is threaded through so the caller (rebindRestoredPane) can attribute the
  // `contested` audit row to R without a second lookup.
  if (!params.incumbent.dead) {
    return { kind: 'refuse', reason: 'incumbent_alive', agentId: row.id }
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
