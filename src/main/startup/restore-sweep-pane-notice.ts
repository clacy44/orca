// S10-21c B2c (D-R148 low 7): a best-effort pane notice with a loud fallback, split out of
// restore-registered-agent-panes.ts to stay under the max-lines ratchet (the module was
// already at its 300-line cap). A throw from `writeHostNoticeToPane` must never abort the
// caller's own outcome (a coded Layer-3 deferral, or the no-row skip) — it degrades to a
// `notice_failed:` sweep note instead, the same shape the no-row site already used.
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { RestoreSweepDeps } from './restore-sweep-types'

export function notifyPaneBestEffort(
  deps: RestoreSweepDeps,
  db: OrchestrationDb,
  hostId: string,
  paneKey: string,
  agentId: string,
  message: string,
  rateKey: string
): void {
  try {
    deps.writeHostNoticeToPane(paneKey, message, { rateKey })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    auditSweepNote(db, hostId, paneKey, agentId, `notice_failed: ${msg}`)
  }
}
