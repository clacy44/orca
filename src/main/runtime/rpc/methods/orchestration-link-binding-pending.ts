// S10-16 C3, R3/R8/R9 (design v6, frozen): responder-side pending state (in-memory only, never
// SQLite), the containment gate, and the userDataPath accessor — split out of
// orchestration-link-binding-peer.ts to stay under the max-lines ratchet.
import { createHash } from 'node:crypto'
import { app } from 'electron'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  LINK_BINDING_PROBE_TTL_MS,
  LINK_BINDING_PENDING_PER_LINK,
  LINK_BINDING_HEX32_LENGTH
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

// R3: link containment gate — first statement after the lane gate, before anything else.
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
  // id, which is correct: it is a new incident from the peer's point of view).
  const containment = db.getContainment('link', pairedDeviceId, 'quarantine')
  const incidentId = createHash('sha256')
    .update(`${pairedDeviceId}:${containment?.createdAt ?? 0}`)
    .digest('hex')
    .slice(0, LINK_BINDING_HEX32_LENGTH)
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: null,
    actorHostId: pairedDeviceId,
    verb: 'federatedLink',
    outcome: 'link_quarantined',
    reasonCode: verb
  })
  throw new OrchestrationError(
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
