// S10-21a C7f (Ruling 34 Addendum 24, D-R114 fix 1): the post-spawn-commit gate pty.ts consults
// at :6937 — the pane's newest daemon_died/rebind audit, narrowed to those two verbs so a later
// 'rebind' (this gate's own prior fire, or C5's `rebindRestoredPane`) always outranks an older
// 'daemon_died' fact and the gate never re-fires once the pane is resolved. Query SHAPE reused
// from `agent-sweep-unrecorded-check.ts`.
import type Database from '../../sqlite/sync-database'
import { paneSuffix } from './agent-restore-rebind-predicate'

export type DaemonRespawnGateVerb = 'daemon_died' | 'rebind'

export function newestDaemonDeathOrRebindVerb(
  db: Database.Database,
  paneKey: string
): DaemonRespawnGateVerb | null {
  const row = db
    .prepare(
      `SELECT verb FROM agent_audit
         WHERE substr(actor_pane_key, instr(actor_pane_key, ':') + 1) = ?
           AND verb IN ('daemon_died', 'rebind')
         ORDER BY seq DESC LIMIT 1`
    )
    .get(paneSuffix(paneKey)) as { verb: DaemonRespawnGateVerb } | undefined
  return row?.verb ?? null
}
