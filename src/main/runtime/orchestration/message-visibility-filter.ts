// S10-2b PURGE/QUARANTINE retrofit onto every pre-v34 read path (amendment E, s10-2-spec.md
// PURGE §: "Filter at the source, not the renderer... in SQL"). One shared predicate/helper so
// every call site applies the identical rule the v34 thread reads (getThreadMessagesSince,
// thread-directory.ts) already use: a purged row is gone, and a row whose author is currently
// quarantined is withheld — never derived from `messages.sender_agent_id` alone (that column is
// NULL for host-generated rows, which are never withheld).
import type Database from '../../sqlite/sync-database'
import type { MessageRow } from './types'

// S10-8 review fix (blocker: quarantine does not cross the link at read time). A cross-host peer
// question's `from_handle` is the synthetic `remote:<environmentId>:<remoteAgentId>` literal
// (orchestration-federated-peer-ask.ts) — there is no local `agents` row for it, so
// `sender_agent_id` is NULL and the local-only clause above always passes it. Reconstructing the
// candidate handle from each `remote_agents` row and comparing by equality (never substring-
// parsing `from_handle`) keeps this correct without a schema change: a row is withheld if EITHER
// its origin host currently asserts it quarantined (`remote_quarantined`) or this host has
// defensively quarantined it after an earlier contact (`local_quarantined`) — re-read every call,
// same "retroactive AND prospective" discipline as the local clause beside it.
export function remoteSenderQuarantinedSqlClause(fromHandleExpr: string): string {
  return (
    `EXISTS (SELECT 1 FROM remote_agents ra WHERE ` +
    `('remote:' || ra.environment_id || ':' || ra.remote_agent_id) = ${fromHandleExpr} ` +
    `AND (ra.remote_quarantined = 1 OR ra.local_quarantined = 1))`
  )
}

/** SQL predicate fragment for a `messages` table reference aliased `m` (or unaliased when
 * `alias` is omitted). AND this into every WHERE clause that reads `messages` directly. */
export function liveMessageSqlClause(alias?: string): string {
  const col = alias ? `${alias}.` : ''
  const remoteClause = remoteSenderQuarantinedSqlClause(`${col}from_handle`)
  return (
    `${col}purged_at IS NULL AND (${col}sender_agent_id IS NULL OR ${col}sender_agent_id NOT IN ` +
    `(SELECT id FROM agents WHERE quarantined = 1)) AND NOT ${remoteClause}`
  )
}

export type LiveMessageFilterOmitted = { purged: number; withheld: number }

export type LiveMessageFilterResult = {
  messages: MessageRow[]
  omitted: LiveMessageFilterOmitted
}

/**
 * Row-level filter for message rows already re-materialized by id (a frozen delivery batch,
 * `getDeliveryMessages`/`fetchMessagesByIds`) — the frozen id list itself is never mutated (a
 * purged id still exists to be `read=1`'d on ack, PURGE § "Frozen delivery batches"), only the
 * rows returned to a caller are filtered. Never trusts `sender_agent_id` from a stale in-memory
 * row for the quarantine check — re-reads current `agents.quarantined` so a quarantine issued
 * after the row was fetched still withholds it.
 */
export function filterLiveMessageRows(
  db: Database.Database,
  rows: readonly MessageRow[]
): LiveMessageFilterResult {
  const quarantinedIds = new Set(
    (db.prepare('SELECT id FROM agents WHERE quarantined = 1').all() as { id: string }[]).map(
      (row) => row.id
    )
  )
  // Cross-host counterpart of quarantinedIds above (see remoteSenderQuarantinedSqlClause's
  // header note) — a remote asker has no `agents` row, so its containment state lives here
  // instead, keyed by the exact synthetic `from_handle` literal it was stored under.
  const quarantinedRemoteHandles = new Set(
    (
      db
        .prepare(
          `SELECT ('remote:' || environment_id || ':' || remote_agent_id) AS handle
           FROM remote_agents WHERE remote_quarantined = 1 OR local_quarantined = 1`
        )
        .all() as { handle: string }[]
    ).map((row) => row.handle)
  )
  let purged = 0
  let withheld = 0
  const messages: MessageRow[] = []
  for (const row of rows) {
    if (row.purged_at) {
      purged++
      continue
    }
    if (row.sender_agent_id && quarantinedIds.has(row.sender_agent_id)) {
      withheld++
      continue
    }
    if (quarantinedRemoteHandles.has(row.from_handle)) {
      withheld++
      continue
    }
    messages.push(row)
  }
  return { messages, omitted: { purged, withheld } }
}
