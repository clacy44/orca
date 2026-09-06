// S10-21b B3 (design §1.1-1.4, §4.4; Ruling 34 Addendum 4) — federated party identity: the
// discriminator, the rendered/resolved party key, `requireAccountablePeer`'s federated arm, and
// the ONE writer that repoints a federated party's anchor after a peer's re-registration or a
// route retarget. Split into its own module (not folded into pact-shared.ts, already near the
// max-lines ratchet) per this repo's precedent (pact-pair-identity.ts split off the same file).
import type Database from '../../sqlite/sync-database'
import { OrchestrationError } from './orchestration-error'
import { writeAgentAudit } from './agent-audit-log'
import type { ThreadRow } from './types'
import type { RemoteAgentRow } from './remote-agent-directory-types'

export type AccountablePeer = {
  id: string
  display_name: string
  federated: boolean
}

// §1.2's standing rule: the federated discriminator is ONE predicate,
// `threads.pact_peer_agent_id IS NOT NULL` — never a string-prefix test against a rendered
// party key. Every federated/local branch from this commit forward reads this.
export function isFederatedPact(thread: Pick<ThreadRow, 'pact_peer_agent_id'>): boolean {
  return thread.pact_peer_agent_id !== null
}

// §1.1: the rendered party key is `remote:<link_device_id>:<remote_agent_id>` — minted here
// exactly like federated-sender-identity.ts's askerHandle, and nowhere else.
export function renderFederatedPartyKey(params: {
  linkDeviceId: string
  remoteAgentId: string
}): string {
  return `remote:${params.linkDeviceId}:${params.remoteAgentId}`
}

// The reverse direction is never a substring parse of a stored/caller-supplied key
// (message-visibility-filter.ts's standing rule) — this reconstructs the candidate handle
// FORWARD from each `remote_agents` row and compares by equality, the same shape
// `remoteSenderQuarantinedSqlClause`/`filterLiveMessageRows` already use.
export function findRemotePartyByRenderedKey(
  db: Database.Database,
  renderedKey: string
): RemoteAgentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM remote_agents WHERE ('remote:' || environment_id || ':' || remote_agent_id) = ?`
    )
    .get(renderedKey) as RemoteAgentRow | undefined
}

// §4.4's `requireAccountablePeer` federated arm: resolves through `remote_agents`, following
// B2's supersession-exclusion predicate (`superseded_at IS NULL` — a single-row check here,
// never the bounded chain walk §4.7 needs elsewhere), and refuses on any of the three
// disqualifying conditions. Returns `undefined` only when `renderedKey` matches no
// `remote_agents` row at all — the caller then falls through to a local-agent lookup. A matched
// but disqualified row throws here rather than falling through, so a superseded/quarantined
// federated peer id always surfaces its real refusal instead of a misleading local
// `agent_unknown`.
export function resolveAccountableRemotePeer(
  db: Database.Database,
  renderedKey: string
): AccountablePeer | undefined {
  const remote = findRemotePartyByRenderedKey(db, renderedKey)
  if (!remote) {
    return undefined
  }
  if (remote.local_quarantined === 1 || remote.remote_quarantined === 1) {
    throw new OrchestrationError(
      'agent_quarantined',
      `Refused: a pact needs two accountable participants and ${remote.display_name} is quarantined.`,
      { nextSteps: ['orca agents ask'] }
    )
  }
  if (remote.superseded_at !== null) {
    throw new OrchestrationError(
      'agent_unknown',
      `Refused: ${remote.display_name} (${renderedKey}) has been superseded by a re-registration.`,
      { nextSteps: ['orca agents find "<plain English description>"'] }
    )
  }
  return { id: renderedKey, display_name: remote.display_name, federated: true }
}

export type RepointFederatedPactPartyParams = {
  linkDeviceId: string
  environmentId: string
  remoteAgentId: string
  reason: string
}

// §1.2/§1.4(b)/§2.10/§5: the ONE writer of a federated party's rendered key. Rewrites, in one
// `BEGIN IMMEDIATE`: the pact columns holding the OLD key (whichever of
// pact_proposer_agent_id/pact_with_agent_id held it, and pact_turn_agent_id iff it currently
// equals it), the matching thread_participants row, the federated anchor columns
// (pact_peer_agent_id/pact_peer_link_device_id/pact_peer_environment_id/
// pact_peer_key_fingerprint — re-derived from peer_link_bindings, never caller-asserted), every
// unsettled peer_reply_outbox row for the pact, and one agent_audit row. Its only intended
// callers are the `rebind_party` apply (B13) and the route retarget (pre-existing) — NEITHER is
// wired to it in this commit; it is exported for them to call.
export function repointFederatedPactParty(
  db: Database.Database,
  threadId: string,
  params: RepointFederatedPactPartyParams
): void {
  const current = db
    .prepare(`SELECT pact_peer_agent_id, pact_peer_link_device_id FROM threads WHERE id = ?`)
    .get(threadId) as
    | { pact_peer_agent_id: string | null; pact_peer_link_device_id: string | null }
    | undefined
  if (!current) {
    throw new OrchestrationError('not_found', `Thread ${threadId} was not found.`)
  }
  const oldKey =
    current.pact_peer_agent_id !== null && current.pact_peer_link_device_id !== null
      ? renderFederatedPartyKey({
          linkDeviceId: current.pact_peer_link_device_id,
          remoteAgentId: current.pact_peer_agent_id
        })
      : null
  const newKey = renderFederatedPartyKey({
    linkDeviceId: params.linkDeviceId,
    remoteAgentId: params.remoteAgentId
  })

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `UPDATE threads SET
         pact_proposer_agent_id =
           CASE WHEN pact_proposer_agent_id = ? THEN ? ELSE pact_proposer_agent_id END,
         pact_with_agent_id =
           CASE WHEN pact_with_agent_id = ? THEN ? ELSE pact_with_agent_id END,
         pact_turn_agent_id =
           CASE WHEN pact_turn_agent_id = ? THEN ? ELSE pact_turn_agent_id END,
         pact_peer_agent_id = ?,
         pact_peer_link_device_id = ?,
         pact_peer_environment_id = ?,
         pact_peer_key_fingerprint = COALESCE(
           (SELECT peer_key_fingerprint FROM peer_link_bindings WHERE link_device_id = ?),
           pact_peer_key_fingerprint
         )
       WHERE id = ?`
    ).run(
      oldKey,
      newKey,
      oldKey,
      newKey,
      oldKey,
      newKey,
      params.remoteAgentId,
      params.linkDeviceId,
      params.environmentId,
      params.linkDeviceId,
      threadId
    )

    if (oldKey !== null) {
      db.prepare(
        `UPDATE thread_participants SET participant_key = ?
         WHERE thread_id = ? AND participant_key = ?`
      ).run(newKey, threadId, oldKey)
    }

    db.prepare(
      `UPDATE peer_reply_outbox SET peer_agent_id = ?, link_device_id = ?, environment_id = ?
       WHERE pact_thread_id = ? AND settled_at IS NULL`
    ).run(params.remoteAgentId, params.linkDeviceId, params.environmentId, threadId)

    writeAgentAudit(db, {
      agentId: null,
      actorPaneKey: null,
      actorHostId: params.linkDeviceId,
      verb: 'repointFederatedPactParty',
      outcome: 'repointed',
      reasonCode: params.reason
    })

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
