// S10-21a C7d (Ruling 34 Addendum 23): the "narrowed identity rebind" for a daemon respawn that
// remounts a pane over a NEW pty WITHOUT moving its pane key — deliberately NOT
// `rebindRestoredPane` (agent-restore-rebind.ts): that function's own clause 3
// (`paneSuffix(predecessor) === paneSuffix(newPaneKey)`) is a structural no-op for a same-pane
// case, by design (Layer 1 preserved, nothing to move) — it never reaches the UPDATE that would
// refresh `terminal_handle`/`process_incarnation`, and a same-pane daemon respawn needs exactly
// that refresh, never a pane-key move. This is a sibling primitive for that narrower shape:
// same pane key, new handle/incarnation, no ticket, no lock, no full sweep.
import type Database from '../../sqlite/sync-database'
import { getAgentByPaneKey } from './derived-agent-rows'
import { getAgentByIdIncludingTombstoned } from './agent-retire'
import { writeAgentAudit } from './agent-audit-log'
import { pactsAwaitingUnpause } from './agent-pact-unpause-lookup'
import { parseProcessIncarnation } from './agent-process-identity'
import {
  newestLaunchForPane,
  recordLaunchInTransaction,
  setLaunchAgentId
} from './agent-launch-sessions'

export type RefreshAgentHandleAfterRespawnParams = {
  hostId: string
  paneKey: string
  newTerminalHandle: string
  processIncarnation?: string | null
  /** [S10-21a C7k, Ruling 34 Addendum 28, item 6] When given, selects the row by id instead of
   * by pane suffix — two registered rows CAN share a pane suffix; a caller that already knows
   * exactly which agent it means (agent-restore-rebind.ts's noop path, `predicate.agentId`) must
   * not let this primitive's own suffix lookup silently pick a different, unrelated row.
   * Existing callers (pty.ts's daemon-respawn gate) omit it and keep the pane-suffix lookup. */
  agentId?: string
  /** [S10-21d R110] When given, records a fresh `agent_launch_sessions` row for this pane in the
   * SAME transaction as the handle refresh — evidence 'daemon_survived', stamped with this
   * generation — so `sessionLaunchKnown` does not read stale (the pane's newest launch row is
   * otherwise left on the PREVIOUS generation forever, diag-r106-r110-2026-09-08.md). Session
   * id/agent type/execution host are read from the pane's own newest launch row
   * (`newestLaunchForPane`), never supplied by the caller — this primitive never invents a
   * session identity. Omitted by pty.ts's admission-time respawn gate, whose own admission path
   * already records a launch row through a different door. */
  currentLaunchGeneration?: string
}

export type RefreshAgentHandleAfterRespawnResult =
  | { ok: true; agentId: string; pactsToUnpause: string[] }
  | {
      ok: false
      reason: 'no_registered_row' | 'row_derived' | 'row_tombstoned' | 'row_quarantined'
    }

/** Updates ONLY `terminal_handle`/`process_incarnation`/`last_seen_at` for the registered,
 * non-derived, non-tombstoned, non-quarantined row already sitting on `paneKey` — never
 * `pane_key` itself (there is nothing to move). Writes one `rebind` audit row either way
 * (`outcome: 'reminted'` on success, `'refused'` with the reason on refusal), matching
 * `rebindRestoredPane`'s own audit shape so both surface identically in `agent_audit`. Returns
 * the same-shaped `pactsToUnpause` list `rebindRestoredPane` returns — the caller (C10, or
 * whichever wiring lands this) un-pauses them post-commit, exactly as C5's own contract states;
 * this function does not call `resumePact` itself.
 *
 * TRANSACTION CONTRACT: opens its own `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` — never call this
 * from inside a caller-held transaction (sqlite3 does not nest `BEGIN`; a nested call throws
 * `cannot start a transaction within a transaction` and the outer transaction rolls back with
 * it). Callers needing this alongside another write (e.g. C10's pact un-pause) must sequence
 * them as separate, back-to-back transactions post-commit, the same convention `rebindRestoredPane`
 * (agent-restore-rebind.ts) and `recordLaunch` (agent-launch-sessions.ts) already use for their
 * own post-commit follow-ups (`prunePaneRows`/`pruneGlobalRows`). */
export function refreshAgentHandleAfterRespawn(
  db: Database.Database,
  params: RefreshAgentHandleAfterRespawnParams
): RefreshAgentHandleAfterRespawnResult {
  const row =
    params.agentId !== undefined
      ? getAgentByIdIncludingTombstoned(db, params.agentId)
      : getAgentByPaneKey(db, params.hostId, params.paneKey)
  if (!row) {
    writeAgentAudit(db, {
      agentId: null,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: 'refused',
      reasonCode: 'daemon_respawn_handle_refresh refused (no_registered_row)'
    })
    return { ok: false, reason: 'no_registered_row' }
  }
  if (row.derived === 1) {
    return refuse(db, params, row.id, 'row_derived')
  }
  if (row.tombstoned_at !== null) {
    return refuse(db, params, row.id, 'row_tombstoned')
  }
  if (row.quarantined === 1) {
    return refuse(db, params, row.id, 'row_quarantined')
  }
  // [S10-21a C7l, Ruling 34 Addendum 29 item 1] Refuse at the write any identity
  // `parseProcessIncarnation` rejects: leave `process_incarnation` untouched (the handle
  // update still proceeds) and record why, rather than poisoning the column with a bare or
  // legacy value. `undefined` (caller omits the field entirely) is unchanged prior behaviour
  // — this only guards a field that WAS supplied.
  const identityUnavailableNote =
    params.processIncarnation !== undefined &&
    parseProcessIncarnation(params.processIncarnation) === null
      ? `identity_unavailable_at_refresh: ${params.processIncarnation === null ? 'null' : 'unparseable'}`
      : null
  db.exec('BEGIN IMMEDIATE')
  try {
    if (params.processIncarnation !== undefined && identityUnavailableNote === null) {
      db.prepare(
        `UPDATE agents SET terminal_handle = ?, process_incarnation = ?,
           last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newTerminalHandle, params.processIncarnation, row.id)
    } else {
      db.prepare(
        `UPDATE agents SET terminal_handle = ?, last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newTerminalHandle, row.id)
    }
    // [S10-21d R110] Same transaction as the UPDATE above: a fresh launch row stamped with the
    // CURRENT generation, so `sessionLaunchKnown` (orchestration-agents-directory.ts) reads true
    // in the new generation instead of comparing against the pane's stale pre-restart row.
    // sessionId/agentType/executionHostId come from the pane's own newest launch row — this
    // primitive never invents a session identity. A same-pane rewrite's current_sessions upsert
    // cannot conflict (current-session-upsert.ts's ON CONFLICT(host_id, pane_key) targets
    // exactly this pane), so recordLaunchInTransaction's own conflict/delete path is provably
    // unreached here; a foreign_session_id it still returned would mean that invariant broke, in
    // which case this loudly notes it rather than trusting an unverified success.
    if (params.currentLaunchGeneration !== undefined) {
      const newest = newestLaunchForPane(db, params.hostId, params.paneKey)
      if (newest) {
        const launchResult = recordLaunchInTransaction(db, {
          hostId: params.hostId,
          paneKey: params.paneKey,
          agentType: newest.agent_type,
          sessionId: newest.session_id,
          launchGeneration: params.currentLaunchGeneration,
          executionHostId: newest.execution_host_id,
          evidence: 'daemon_survived'
        })
        if (launchResult.ok) {
          // [S10-21d D-R162 M-1] Every sibling writer of a launch row binds agent_id
          // (agent-restore-rebind.ts:196,357,408; agent-lineage-mismatch.ts:387) — this one
          // didn't, leaving retire() an orphan newest row that suppresses S5 bootstrap for the
          // pane's next occupant (agent-lineage-mismatch.ts).
          setLaunchAgentId(db, { seq: launchResult.row.seq }, row.id)
        } else {
          writeAgentAudit(db, {
            agentId: row.id,
            actorPaneKey: params.paneKey,
            actorHostId: params.hostId,
            verb: 'rebind',
            outcome: 'refused',
            reasonCode: `daemon_survived_launch_row_refused: ${launchResult.reason}`
          })
        }
      } else {
        writeAgentAudit(db, {
          agentId: row.id,
          actorPaneKey: params.paneKey,
          actorHostId: params.hostId,
          verb: 'rebind',
          outcome: 'refused',
          reasonCode: 'daemon_survived_launch_row_missing: no prior launch row for pane'
        })
      }
    }
    const pactsToUnpause = pactsAwaitingUnpause(db, row.id)
    writeAgentAudit(db, {
      agentId: row.id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: 'reminted',
      reasonCode: identityUnavailableNote
        ? `daemon respawn handle refresh: ${params.paneKey} -> ${params.newTerminalHandle} (${identityUnavailableNote})`
        : `daemon respawn handle refresh: ${params.paneKey} -> ${params.newTerminalHandle}`
    })
    db.exec('COMMIT')
    return { ok: true, agentId: row.id, pactsToUnpause }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function refuse(
  db: Database.Database,
  params: RefreshAgentHandleAfterRespawnParams,
  agentId: string,
  reason: Extract<RefreshAgentHandleAfterRespawnResult, { ok: false }>['reason']
): { ok: false; reason: typeof reason } {
  writeAgentAudit(db, {
    agentId,
    actorPaneKey: params.paneKey,
    actorHostId: params.hostId,
    verb: 'rebind',
    outcome: 'refused',
    reasonCode: `daemon_respawn_handle_refresh refused (${reason})`
  })
  return { ok: false, reason }
}
