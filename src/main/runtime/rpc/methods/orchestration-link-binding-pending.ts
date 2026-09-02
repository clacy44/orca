// S10-16 C3, R3/R8/R9 (design v6, frozen): responder-side pending state (in-memory only, never
// SQLite), the containment gate, and the userDataPath accessor — split out of
// orchestration-link-binding-peer.ts to stay under the max-lines ratchet.
import { app } from 'electron'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  LINK_BINDING_PROBE_TTL_MS,
  LINK_BINDING_PENDING_PER_LINK,
  LINK_BINDING_RATE_WINDOW_MS,
  deriveLinkQuarantineIncidentId
} from '../../orchestration/link-binding-constants'
import type { PendingAnswer } from './orchestration-link-binding-wire'

// Why: the RPC boundary sees only `OrcaRuntimeService`, never `RuntimeRpcServer` — userDataPath is
// resolved directly, the same value `OrcaRuntimeService::getOrchestrationDb()` resolves for its
// own db path (orca-runtime.ts), not passed through RpcContext.
export function resolveUserDataPath(): string {
  return app.getPath('userData')
}

// R8: responder-side pending state is IN-MEMORY ONLY, never SQLite — losing it on restart costs
// one retry, never correctness. Keyed per runtime instance (never a bare module-level Map) so
// concurrent test harnesses simulating two hosts in one process never share state, and per link
// device id within that so R8.2's within-link eviction and R8.3's epoch supersession are natural.
const pendingByRuntime = new WeakMap<object, Map<string, Map<string, PendingAnswer>>>()

export function pendingForRuntime(runtimeKey: object): Map<string, Map<string, PendingAnswer>> {
  let byLink = pendingByRuntime.get(runtimeKey)
  if (!byLink) {
    byLink = new Map()
    pendingByRuntime.set(runtimeKey, byLink)
  }
  return byLink
}

export function pruneExpired(byProbeId: Map<string, PendingAnswer>, now: number): void {
  for (const [probeId, answer] of byProbeId) {
    if (now - answer.createdAt > LINK_BINDING_PROBE_TTL_MS) {
      byProbeId.delete(probeId)
    }
  }
}

// R8.2: no global cap; within one link's own budget, overflow evicts that link's OLDEST
// unconsumed record (never a refusal — a global cap would re-introduce cross-link denial).
export function evictOldestIfOverCap(byProbeId: Map<string, PendingAnswer>): void {
  while (byProbeId.size > LINK_BINDING_PENDING_PER_LINK) {
    let oldestProbeId: string | null = null
    let oldestAt = Infinity
    for (const [probeId, answer] of byProbeId) {
      if (answer.createdAt < oldestAt) {
        oldestAt = answer.createdAt
        oldestProbeId = probeId
      }
    }
    if (oldestProbeId === null) {
      return
    }
    byProbeId.delete(oldestProbeId)
  }
}

// R8.3: a probe from link L with epoch e releases every pending record for L whose epoch is < e.
export function releaseSuperseded(byProbeId: Map<string, PendingAnswer>, epoch: number): void {
  for (const [probeId, answer] of byProbeId) {
    if (answer.epoch < epoch) {
      byProbeId.delete(probeId)
    }
  }
}

// C3a delta D2: a marker subclass so a caller's outer catch can exclude an `agent_quarantined`
// refusal ORIGINATING AT THIS GATE from its own per-refusal audit write (this gate already wrote
// — or, per D3, deliberately withheld under its own meter — the audit row for it) without also
// excluding an `agent_quarantined` a handler throws for an unrelated reason (a quarantined
// RECIPIENT — addressable-agent-recipient.ts — or a quarantined SENDER —
// federated-sender-identity.ts), which must still reach the caller's own audit write every time.
// `instanceof` on this class is the discriminator, never `.code` alone.
export class LinkContainmentRefusal extends OrchestrationError {}

// R3: link containment gate — first statement after the lane gate, before anything else. Review
// F1's original problem stands: the `agent_audit` write this gate performs is an undeletable-
// table DoS for a quarantined-but-still-authenticated peer with no meter in front of it.
// C3a delta D3 (chair-adopted): the refusal fires on EVERY call from a quarantined link — never
// downgrades to `rate_limited` — while the audit WRITE is metered separately, `limit: 1` per
// `LINK_BINDING_RATE_WINDOW_MS` per verb per link (`linkQuarantineAudit:<verb>`), so a quarantined
// peer can produce at most one `agent_audit` row per window per verb regardless of call volume —
// closing the same undeletable-table DoS the prior scheme closed, without ever substituting a
// wrong disposition (`rate_limited`) for the true one (`agent_quarantined`) on the wire.
export function refuseIfQuarantined(
  runtime: OrcaRuntimeService,
  pairedDeviceId: string,
  verb: string
): void {
  const db = runtime.getOrchestrationDb()
  if (!db.isPeerLinkQuarantined(pairedDeviceId)) {
    return
  }
  // Lifecycle m4: the incident id has no dedicated column on `peer_link_containment` (R14 DDL) —
  // derived deterministically from the containment row's own identity so it is stable for the
  // life of one quarantine (a lift + re-assert is a new row-content generation and yields a new
  // id, which is correct: it is a new incident from the peer's point of view). The id is
  // deterministic, not opaque (F10): a recipient who knows its own device id can brute-force
  // `createdAt` over a plausible window; the value is a stable label, not a secret. A missing
  // containment row here (the read above found one, so `getContainment` should too) is a refusal
  // path, never an opaque-but-wrong id — no silent `?? 0` fallback.
  const containment = db.getContainment('link', pairedDeviceId, 'quarantine')
  if (!containment) {
    throw new LinkContainmentRefusal(
      'agent_quarantined',
      `This paired link is quarantined on this host and cannot ${verb}.`,
      {
        nextSteps: [
          'this link is quarantined on this host; ask the operator to lift it with `orca environment link-quarantine --lift`'
        ]
      }
    )
  }
  const incidentId = deriveLinkQuarantineIncidentId(pairedDeviceId, containment.createdAt)
  const auditGate = db.checkAndBumpRate({
    subjectKey: `linkbind:${pairedDeviceId}`,
    verb: `linkQuarantineAudit:${verb}`,
    windowMs: LINK_BINDING_RATE_WINDOW_MS,
    limit: 1
  })
  if (auditGate.allowed) {
    db.writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: pairedDeviceId,
      verb: 'federatedLink',
      outcome: 'link_quarantined',
      reasonCode: verb
    })
  }
  throw new LinkContainmentRefusal(
    'agent_quarantined',
    `This paired link is quarantined on this host and cannot ${verb}.`,
    {
      nextSteps: [
        'this link is quarantined on this host; ask the operator to lift it with `orca environment link-quarantine --lift`'
      ],
      advisory: { kind: 'link_quarantined', incidentId }
    }
  )
}
