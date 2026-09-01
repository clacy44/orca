// S10-15 chair ruling 1 (finding 1 — one extraction, one policy): the shared inbound-identity
// code, extracted ONCE out of orchestration-federated-peer-ask.ts, in a shape that never throws
// (a result union) so both the ask path (byte-identical refusals, adapted at its call site) and
// the routing slice's relayed-send method (deliver-on-malformed, refuse-on-quarantined, D3) can
// consume the SAME validation/upsert code rather than drifting copies. Lives under
// `main/runtime/orchestration/` (not `rpc/methods/`) for the same reason
// addressable-agent-recipient.ts does: both orchestration.ts and orchestration-federated-peer-
// ask.ts need it without a cycle back into orchestration.ts.
//
// S10-15 D1, amended (finding 12 + ruling 6): the wire fragment carries NO `host` field. D1's
// original text proposed sending `hostname()` across the link so `environment_name` renders a
// real label instead of the raw link id — the breaker showed that value is then interpolated in
// `name@host` shape in refusal text, and a peer-chosen hostname can collide with (or spoof) one
// of THIS host's own saved environment names, which `db.ts`'s own `environment_name` column
// comment says must "never [be] an address." D1's own veto point takes the safe branch: omit the
// field entirely, keep `hostLabel` an empty string always, and let `environment_name` fall back
// to the link key exactly as it does today when `host` is absent.
import { z } from 'zod'
import { requiredString } from '../rpc/schemas'
import { OrchestrationError } from './orchestration-error'
import { REMOTE_AGENTS_PER_LINK_CAP, type OrchestrationDb } from './db'
import type { RemoteAgentRow } from './remote-agent-directory-types'
import {
  sanitizeDirectoryText,
  sanitizeRole,
  validateDisplayNameCandidate
} from './agent-name-sanitizer'

// Mirrors agents-cross-host.ts's FOREIGN_AGENT_ID_RE: a peer-supplied id is re-emitted verbatim
// into this host's own thread/message rows (the synthetic `remote:<link>:<id>` from-handle
// below), so it must match the only shape a genuine directory id can have — anything else is
// refused, never rendered or stored.
const FOREIGN_AGENT_ID_RE = /^agt_[0-9a-f]{12}$/

// D1: `host` is OMITTED (finding 12 + ruling 6) — no wire field, no hostname() call, no new
// label column. `role`/`quarantined` stay optional exactly as today.
export const FederatedSenderIdentitySchema = z.object({
  id: requiredString('Missing sender agent id'),
  displayName: requiredString('Missing sender display name'),
  role: z.string().nullable().optional(),
  // S10-8 review fix (blocker: quarantine crosses the link): the origin host's own assertion
  // that this caller is currently quarantined there — carried so the receiver can refuse
  // independently of the pre-relay check on the sending side (defense in depth, never the only
  // guard: a hostile/buggy peer could always send `false`).
  quarantined: z.boolean().optional()
})
export type FederatedSenderIdentity = z.infer<typeof FederatedSenderIdentitySchema>

/** Resolved from the attested pane's registered directory row — NEVER caller-supplied.
 *  Returns undefined when the caller has no registered `agents` row (unregistered pane);
 *  callers then omit `fromAgent` from the envelope entirely. */
export function buildFederatedSenderIdentity(
  db: OrchestrationDb,
  callerAgentId: string
): FederatedSenderIdentity | undefined {
  const row = db.getAgentById(callerAgentId)
  if (!row) {
    return undefined
  }
  return {
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    quarantined: row.quarantined === 1
  }
}

export type RemoteIdentityImport =
  | {
      outcome: 'imported'
      row: RemoteAgentRow
      displayName: string
      hostLabel: string
      /** `remote:<linkKey>:<remoteAgentId>` — the synthetic from-handle, minted here so every
       *  producer of it agrees (orchestration-federated-peer-ask.ts today). */
      askerHandle: string
    }
  | { outcome: 'absent' }
  | {
      outcome: 'invalid'
      reason: 'id_shape' | 'local_collision' | 'display_name'
      error: OrchestrationError
    }
  | { outcome: 'quarantined'; scope: 'local' | 'remote'; error: OrchestrationError }
  // S10-15 ruling 2 (finding 4 — fingerprint<->link binding, owned by the identity slice): the
  // link's own authenticated fingerprint (never a peer-body-asserted one) is bound to the link
  // key (`pairedDeviceId`) on first contact (TOFU) and refused on any later mismatch in either
  // direction — a hostile-or-compromised, but legitimately paired, peer Q must never be able to
  // claim P's already-bound fingerprint, and a fingerprint that already speaks for one link must
  // never be admitted again under a second one.
  | {
      outcome: 'fingerprint_conflict'
      scope: 'link_changed' | 'cross_link_duplicate'
      error: OrchestrationError
    }
  // S10-15 ruling 3(b): the per-link cap on DISTINCT mirrored peer agents. Refusing the MIRROR
  // WRITE alone (never the mail/ask itself) is the whole point — a flood of distinct bogus ids
  // must never evict, or block delivery for, the legitimate row. `row` is intentionally absent:
  // nothing was written.
  | { outcome: 'capped'; displayName: string; hostLabel: string; askerHandle: string }

/**
 * The shared inbound-identity importer (D2). Preserves the EXACT order the pre-extraction code
 * ran in — load-bearing: the upsert happens before the quarantine reads so a quarantined peer's
 * row still refreshes `last_seen_at` and its `remote_quarantined` flip is honored.
 *
 *  1. id-shape check
 *  2. local-id-collision refusal
 *  3. display-name sanitize + validate
 *  4. role sanitize
 *  5. hostLabel — always '' (D1 amendment: host is never sent, never read)
 *  6. peer-fingerprint binding check (ruling 2) — before the write, since the write is what
 *     would bind an unvalidated fingerprint
 *  7. per-link cap check (ruling 3b) — before the write, for the same reason
 *  8. upsert (never names local_quarantined — finding 8)
 *  9. re-read -> local_quarantined refusal (unioned across link kinds via
 *     `db.isRemoteAgentLocallyQuarantined`, finding 7)
 * 10. re-read -> remote_quarantined refusal (strictly per-row)
 */
export function importFederatedSenderIdentity(
  db: OrchestrationDb,
  args: {
    identity: FederatedSenderIdentity | undefined
    linkKey: string
    /** The link's own authenticated fingerprint (`authenticatedCallerFingerprint`), never a
     *  peer-body-asserted value — ruling 2's binding is over THIS, not over anything the
     *  `FederatedSenderIdentity` envelope carries. */
    peerFingerprint: string
    /** S10-15 review m-5/m-6: the quarantine refusal text below names the verb the caller
     *  actually invoked — 'ask' (default, preserves federatedAsk's existing wording
     *  byte-for-byte) or 'send' (federatedSend, which was wrongly saying "cannot ask"). */
    verb?: 'ask' | 'send'
  }
): RemoteIdentityImport {
  const { identity, linkKey, peerFingerprint, verb = 'ask' } = args
  if (!identity) {
    return { outcome: 'absent' }
  }

  if (!FOREIGN_AGENT_ID_RE.test(identity.id)) {
    return {
      outcome: 'invalid',
      reason: 'id_shape',
      error: new OrchestrationError(
        'invalid_argument',
        'The relayed sender id is not a valid agent directory id.',
        {
          nextSteps: [
            'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
          ]
        }
      )
    }
  }

  // S10-8 review fix (blocker: peer-controlled identity collides with the local namespace): a
  // peer that claims a LOCAL agent's own id must never be trusted — S10-4 ruling 1 keeps foreign
  // claims out of the `agents` id namespace specifically so a remote_agents row can never be
  // mistaken for (or shadow) a real local one. Also closes a self-relay loop: a runtime relaying
  // into itself presents an id this same check already owns locally.
  if (db.getAgentById(identity.id)) {
    return {
      outcome: 'invalid',
      reason: 'local_collision',
      error: new OrchestrationError(
        'invalid_argument',
        'The relayed sender id collides with an agent already registered on this host.',
        {
          nextSteps: [
            'verify the paired link is a genuine remote peer, not a loop back to this same host'
          ]
        }
      )
    }
  }

  const displayNameCandidate = sanitizeDirectoryText(identity.displayName, 80).value
  if (!displayNameCandidate || !validateDisplayNameCandidate(displayNameCandidate).ok) {
    return {
      outcome: 'invalid',
      reason: 'display_name',
      error: new OrchestrationError(
        'invalid_argument',
        'The relayed sender display name is not addressable.',
        {
          nextSteps: [
            'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
          ]
        }
      )
    }
  }

  const role = sanitizeRole(identity.role ?? null)?.value ?? null
  // D1 amendment: no host field exists on the wire — this is always '', which is exactly
  // today's behavior when a peer omits `host`.
  const hostLabel = ''

  // Ruling 2: bind on first use, refuse on any later mismatch in either direction.
  const boundFingerprint = db.getBoundPeerFingerprintForLink(linkKey)
  if (boundFingerprint !== null && boundFingerprint !== peerFingerprint) {
    return {
      outcome: 'fingerprint_conflict',
      scope: 'link_changed',
      error: new OrchestrationError(
        'invalid_argument',
        'This link is asserting a different identity than it did on an earlier contact.',
        {
          nextSteps: [
            're-pair the two hosts if the peer was genuinely reimaged or its keys rotated'
          ]
        }
      )
    }
  }
  const conflictingEnvironmentId = db.findEnvironmentIdForPeerFingerprint(peerFingerprint, linkKey)
  if (conflictingEnvironmentId !== null) {
    return {
      outcome: 'fingerprint_conflict',
      scope: 'cross_link_duplicate',
      error: new OrchestrationError(
        'invalid_argument',
        'This identity is already bound to a different paired link.',
        {
          nextSteps: ['verify the paired link is a genuine remote peer, not a duplicate pairing']
        }
      )
    }
  }

  // Ruling 3(b): only a genuinely NEW distinct remote agent id counts against the cap — an
  // update to an already-mirrored row never evicts, and never gets capped, no matter how full
  // the link's row set is.
  const isNewRow = !db.hasRemoteAgent(linkKey, identity.id)
  if (isNewRow && db.countRemoteAgentsForLink(linkKey) >= REMOTE_AGENTS_PER_LINK_CAP) {
    const askerHandle = `remote:${linkKey}:${identity.id}`
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: linkKey,
      verb: 'federatedSendIdentity',
      outcome: 'identity_rejected:remote_agents_cap',
      reasonCode: null
    })
    return { outcome: 'capped', displayName: displayNameCandidate, hostLabel, askerHandle }
  }

  // S10-4 ruling 1: upsert a peer-asserted agent-directory row into the SEPARATE remote_agents
  // table, keyed by the link (never a genuine local environment id on this inbound path — see
  // db.ts's `link_kind` comment). A remote-quarantine flip is honored; a local quarantine is
  // never cleared by this path (trg_remote_lift_scope enforces it even if a caller forgets to
  // check, and finding 8's constraint keeps upsertRemoteAgent from ever naming the column).
  const upsertResult = db.upsertRemoteAgent({
    environmentId: linkKey,
    environmentName: hostLabel || linkKey,
    linkKind: 'paired_device',
    remoteAgentId: identity.id,
    displayName: displayNameCandidate,
    role,
    state: 'live',
    derived: false,
    remoteQuarantined: identity.quarantined === true,
    peerFingerprint
  })

  // V-2 fix: the pre-check above (isNewRow && countRemoteAgentsForLink >= CAP) guards only
  // this call site — better-sqlite3 is synchronous in-process, so no concurrent insert can
  // interleave here. The backstop is for a future caller that skips the pre-check.
  // upsertRemoteAgent re-checks atomically and reports 'capped' itself in that case; honor it
  // exactly like the pre-check's own capped branch (same audit fields, same return shape)
  // instead of discarding it and falling through to the "row must exist" branch below, which
  // would misreport this as `id_shape`.
  if (upsertResult.outcome === 'capped') {
    const askerHandle = `remote:${linkKey}:${identity.id}`
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: linkKey,
      verb: 'federatedSendIdentity',
      outcome: 'identity_rejected:remote_agents_cap',
      reasonCode: null
    })
    return { outcome: 'capped', displayName: displayNameCandidate, hostLabel, askerHandle }
  }

  // Finding 7: the local-quarantine union lives in ONE accessor — a peer agent quarantined on
  // its `link_kind='environment'` row must still be refused when it arrives over its
  // `paired_device` row, and vice versa.
  if (db.isRemoteAgentLocallyQuarantined(identity.id)) {
    return {
      outcome: 'quarantined',
      scope: 'local',
      error: new OrchestrationError(
        'agent_quarantined',
        `${displayNameCandidate}@${hostLabel || linkKey} is quarantined on this host and cannot ${verb}.`,
        {
          nextSteps: [
            `this host quarantined ${displayNameCandidate}@${hostLabel || linkKey} after an earlier contact`,
            'orca agents list --all-hosts'
          ]
        }
      )
    }
  }

  const remoteRow = db
    .listRemoteAgents({ environmentId: linkKey, includeQuarantined: true })
    .find((row) => row.remote_agent_id === identity.id)
  if (remoteRow?.remote_quarantined) {
    return {
      outcome: 'quarantined',
      scope: 'remote',
      error: new OrchestrationError(
        'agent_quarantined',
        `${displayNameCandidate}@${hostLabel || linkKey} is quarantined on its origin host and cannot ${verb}.`,
        {
          nextSteps: [
            `${displayNameCandidate} is quarantined on its own host — lift it there with "orca agents quarantine ${displayNameCandidate} --lift"`
          ]
        }
      )
    }
  }

  if (!remoteRow) {
    // Unreachable in practice: the upsert immediately above always creates or refreshes this
    // exact (linkKey, identity.id) row. Defensive typed refusal rather than a thrown TypeError
    // on `undefined.foo` if that invariant is ever broken.
    return {
      outcome: 'invalid',
      reason: 'id_shape',
      error: new OrchestrationError(
        'invalid_argument',
        'The relayed sender id is not a valid agent directory id.',
        {
          nextSteps: [
            'this indicates a version-mismatched or malformed peer relay — update Orca on the asking host'
          ]
        }
      )
    }
  }

  return {
    outcome: 'imported',
    row: remoteRow,
    displayName: displayNameCandidate,
    hostLabel,
    askerHandle: `remote:${linkKey}:${identity.id}`
  }
}
