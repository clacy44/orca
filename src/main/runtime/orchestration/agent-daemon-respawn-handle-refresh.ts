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
import { writeAgentAudit } from './agent-audit-log'
import { pactsAwaitingUnpause } from './agent-restore-rebind'

export type RefreshAgentHandleAfterRespawnParams = {
  hostId: string
  paneKey: string
  newTerminalHandle: string
  processIncarnation?: string | null
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
  const row = getAgentByPaneKey(db, params.hostId, params.paneKey)
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
  db.exec('BEGIN IMMEDIATE')
  try {
    if (params.processIncarnation !== undefined) {
      db.prepare(
        `UPDATE agents SET terminal_handle = ?, process_incarnation = ?,
           last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newTerminalHandle, params.processIncarnation, row.id)
    } else {
      db.prepare(
        `UPDATE agents SET terminal_handle = ?, last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newTerminalHandle, row.id)
    }
    const pactsToUnpause = pactsAwaitingUnpause(db, row.id)
    writeAgentAudit(db, {
      agentId: row.id,
      actorPaneKey: params.paneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: 'reminted',
      reasonCode: `daemon respawn handle refresh: ${params.paneKey} -> ${params.newTerminalHandle}`
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
