// S10-21b B11 (design §3.3, Addendum 6(3), closes N4) — the three facts an expiring `wait
// --for pact`/`--for step` renders, and `pact --show` renders durably outside a wait too:
// last-heard time, the link health word, and the peer's live-mirrored directory state. None of
// these auto-pauses anything.
//
// FINDING (this commit): v2's `PACT_PEER_SILENCE_MS` and its standalone staleness sweep, which
// SCOPE item 1 says to delete, do not exist anywhere in this tree at this commit's base
// (151845af72) — confirmed by an exhaustive `grep -rn PACT_PEER_SILENCE_MS src/` (zero hits) and
// by reading `autoPauseOneThread` (pact-lifecycle.ts), whose only callers are the K6/K17
// counterpart_gone/counterpart_left/counterpart_quarantined/thread_closed/thread_paused
// producers — none staleness-driven. The design's own §3.3 text (v2's defect, restated) frames
// this as a v2 DESIGN artifact D-R88 found broken and Addendum 6(3) retired outright; this
// codebase's v3 implementation apparently never built it. There is therefore nothing to delete
// here — see this commit's body for the same note.
//
// The link-evidence AUTO-PAUSE producer that also consumes fact 1's health word is commit 15's
// (design §3.3, Addendum 6(13)/errata 6(16)) — this file only ever renders, never pauses.
import type Database from '../../sqlite/sync-database'
import type { ThreadRow } from './types'
import { isFederatedPact } from './pact-federated-identity'
import { describeReplyRelayLinkHealth, type ReplyRelayLinkHealthWord } from './reply-outbox-health'
import { listReplyOutboxHealthRows } from './reply-outbox-health-rows'

export type PactCounterpartState = 'live' | 'idle' | 'gone' | 'quarantined' | 'unknown'

export type PactWaitExpiryFacts = {
  // fact 0 (unconditional): `pact_last_inbound_at`, purely informative, never a deadline input
  // (§3.3's core rule) — present for a local pact too (always null there; the column is only
  // ever written by the federated inbound-apply/resync paths).
  lastInboundAt: string | null
  // fact 1's rendered word (federated only; null for a local pact — no link, no outbox rows).
  linkHealth: ReplyRelayLinkHealthWord | null
  // fact 2 (federated only): the peer's state as last mirrored into `remote_agents` (S10-4
  // ruling 1) — "the peer directory, queried live" IS this local mirror in this codebase; there
  // is no separate outbound RPC to make at wait-expiry time (see queryCounterpartLiveState).
  // null for a local pact (not applicable — never confused with 'unknown', which means the
  // query ran and found nothing, or failed).
  peerState: PactCounterpartState | null
  // SCOPE item 2: a query failure is itself informative, never silently swallowed — this
  // distinguishes "no mirror row yet" (failed:false, state:'unknown') from "the read itself
  // threw" (failed:true, state:'unknown').
  peerStateQueryFailed: boolean
}

type FederatedThreadFacts = Pick<
  ThreadRow,
  'pact_last_inbound_at' | 'pact_peer_link_device_id' | 'pact_peer_agent_id'
>

// fact 2, exported standalone so a test can assert it was INVOKED (T22's assertion point: "the
// query is invoked, not merely described") — spy this export directly, not
// computePactWaitExpiryFacts below, which would satisfy a spy without proving the query itself
// ran.
export function queryCounterpartLiveState(
  db: Database.Database,
  thread: Pick<ThreadRow, 'pact_peer_link_device_id' | 'pact_peer_agent_id'>
): { state: PactCounterpartState; failed: boolean } {
  if (!thread.pact_peer_link_device_id || !thread.pact_peer_agent_id) {
    return { state: 'unknown', failed: false }
  }
  try {
    const row = db
      .prepare(
        `SELECT state, remote_quarantined, local_quarantined FROM remote_agents
         WHERE environment_id = ? AND remote_agent_id = ?`
      )
      .get(thread.pact_peer_link_device_id, thread.pact_peer_agent_id) as
      | { state: 'live' | 'idle' | 'gone'; remote_quarantined: number; local_quarantined: number }
      | undefined
    if (!row) {
      return { state: 'unknown', failed: false }
    }
    if (row.remote_quarantined === 1 || row.local_quarantined === 1) {
      return { state: 'quarantined', failed: false }
    }
    return { state: row.state, failed: false }
  } catch {
    return { state: 'unknown', failed: true }
  }
}

// fact 1's link-health word — reuses `describeReplyRelayLinkHealth` verbatim against this link's
// own outbox rows (NA2: derivable today, no new producer for the word itself). A local pact (no
// `pact_peer_link_device_id`) has none. Exported (not called internally by
// computePactWaitExpiryFacts below) for the same reason `queryCounterpartLiveState` is exported
// standalone — a same-module function call bypasses `vi.spyOn`'s module-namespace interception,
// so the bundling function below calls both of these only from ITS OWN caller (db.ts), never
// internally, keeping every fact independently spy-able.
export function queryLinkHealth(
  db: Database.Database,
  thread: Pick<ThreadRow, 'pact_peer_link_device_id'>,
  now: number
): ReplyRelayLinkHealthWord | null {
  if (!thread.pact_peer_link_device_id) {
    return null
  }
  const rows = listReplyOutboxHealthRows(db, thread.pact_peer_link_device_id, now)
  return describeReplyRelayLinkHealth(rows, now)
}

// Bundling convenience for a caller that does not need per-fact spying (e.g. `pact --show`'s
// RPC handler). `db.ts`'s `computePactWaitExpiryFacts` — the one T22 exercises — calls
// `queryLinkHealth`/`queryCounterpartLiveState` directly instead of through this function, so a
// test spying either export (a cross-module call from db.ts) actually intercepts it.
export function computePactWaitExpiryFacts(
  db: Database.Database,
  thread: FederatedThreadFacts,
  now: number
): PactWaitExpiryFacts {
  if (!isFederatedPact(thread)) {
    return {
      lastInboundAt: thread.pact_last_inbound_at,
      linkHealth: null,
      peerState: null,
      peerStateQueryFailed: false
    }
  }
  const linkHealth = queryLinkHealth(db, thread, now)
  const { state, failed } = queryCounterpartLiveState(db, thread)
  return {
    lastInboundAt: thread.pact_last_inbound_at,
    linkHealth,
    peerState: state,
    peerStateQueryFailed: failed
  }
}
