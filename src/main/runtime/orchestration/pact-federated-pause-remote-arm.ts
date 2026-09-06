// S10-21b B14 (design §4.4, D-R135 F17) — split out of pact-lifecycle.ts (max-lines ratchet):
// the two small reads `pauseConditionCleared`'s remote arms need — the B2 chain-walk quarantine
// union, and the host pause ledger row's own `reason_code` disambiguator (errata NB1).
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import type { SupersessionChainWalker } from './pact-federated-rebind'

// Remote arm (design §4.4 row 1): "neither the local party's agents.quarantined NOR any row in
// the remote party's supersession chain has local_quarantined or remote_quarantined set." Reads
// `remote_agents` (the quarantine union, B2's chain walk) — NEVER `agents`, which a rendered
// `remote:<link>:<id>` key can never match. "A counterpart_quarantined pause on a federated pact
// is NOT resumable while the mirror is quarantined."
export function remoteMirrorQuarantined(
  db: Database.Database,
  thread: ThreadRow,
  walkSupersessionChain: SupersessionChainWalker
): boolean {
  const linkKey = thread.pact_peer_link_device_id
  const remoteAgentId = thread.pact_peer_agent_id
  if (!linkKey || !remoteAgentId) {
    return false
  }
  const chain = walkSupersessionChain(remoteAgentId, linkKey)
  if (chain.length === 0) {
    return false
  }
  const placeholders = chain.map(() => '?').join(',')
  const row = db
    .prepare(
      `SELECT 1 FROM remote_agents
       WHERE environment_id = ? AND remote_agent_id IN (${placeholders})
         AND (local_quarantined = 1 OR remote_quarantined = 1)`
    )
    .get(linkKey, ...chain)
  return row !== undefined
}

// design §4.4: "reads the pause's own host `pause` ledger row (the latest un-resumed one for
// the thread) and switches on its reason_code" — the disambiguator between the plain K17
// local-agents-driven counterpart_gone pause and the link-evidence counterpart_unreachable one.
// Also backs `latestPausingAgentId`'s D-R134 F13 fix (actor_is_remote = 0 filter).
export function latestHostPauseReasonCode(db: Database.Database, threadId: string): string | null {
  const row = db
    .prepare(
      `SELECT reason_code FROM pact_steps
       WHERE thread_id = ? AND kind = 'pause' AND actor_is_remote = 0
       ORDER BY seq DESC LIMIT 1`
    )
    .get(threadId) as { reason_code: string | null } | undefined
  return row?.reason_code ?? null
}

// D-R134 F13 / D-R135 (iv): filtered to actor_is_remote = 0 — since B8 a PEER may write a
// 'pause' row too (a relayed pause), and an unfiltered latest-row read let a relayed pause
// shadow our own host pause row, turning "either party may resume once the condition cleared"
// into "resume is requested from a remote key." A peer's own pause is tracked separately via
// `pact_peer_paused_at`, never through this host-pause lookup.
export function latestPausingAgentId(db: Database.Database, threadId: string): string | null {
  const row = db
    .prepare(
      `SELECT actor_agent_id FROM pact_steps
       WHERE thread_id = ? AND kind = 'pause' AND actor_is_remote = 0
       ORDER BY seq DESC LIMIT 1`
    )
    .get(threadId) as { actor_agent_id: string | null } | undefined
  return row?.actor_agent_id ?? null
}
