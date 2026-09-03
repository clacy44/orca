// S10-16 C3, R7.3 (design v6, frozen); reordered by C5 R27.2 (Ruling 23 Addendum 3): the
// `orchestration.federatedLinkProbe` handler body — split out of orchestration-link-binding-
// peer.ts to stay under the max-lines ratchet. Order is load-bearing: lane gate, rate limit,
// quarantine, self-view, store precondition, scan, answer.
import { randomBytes } from 'node:crypto'
import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { isUnauthenticatedLaneCallerFingerprint } from '../../orchestration/db'
import { LINK_BINDING_PROTOCOL, PROOF_LABEL } from '../../orchestration/link-binding-proof'
import {
  LINK_BINDING_RATE_WINDOW_MS,
  LINK_BINDING_RATE_LIMIT,
  LINK_BINDING_NONCE_BYTES
} from '../../orchestration/link-binding-constants'
import {
  scanEnvironmentsForSelectors,
  computeCandidateMacFromEnvironments,
  type LinkBindingCandidate
} from '../../../ipc/runtime-environment-link-binding'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { LinkBindingCapError } from '../../orchestration/link-binding-store'
import {
  resolveUserDataPath,
  pendingForRuntime,
  pruneExpired,
  evictOldestIfOverCap,
  releaseSuperseded,
  refuseIfQuarantined
} from './orchestration-link-binding-pending'
import {
  FederatedLinkProbeParams,
  type FederatedLinkSlotResult,
  type FederatedLinkProbeResult,
  type PendingSlot,
  type PendingAnswer
} from './orchestration-link-binding-wire'

export const FEDERATED_LINK_PROBE_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.federatedLinkProbe',
  params: FederatedLinkProbeParams,
  handler: async (
    params,
    { runtime, pairedDeviceId, clientKind, authenticatedCallerFingerprint, clientId }
  ) => {
    // Step 1: lane gate — worded and shaped exactly as orchestration-federated-peer-ask.ts.
    if (
      !pairedDeviceId ||
      clientKind !== 'runtime' ||
      isUnauthenticatedLaneCallerFingerprint(authenticatedCallerFingerprint)
    ) {
      throw new OrchestrationError(
        'unauthenticated_lane',
        'Link-binding probes require an authenticated paired-runtime link, not a local caller.',
        {
          nextSteps: [
            'this call must arrive over a paired runtime link, never a local pane or an old CLI — re-pair the two hosts if this persists'
          ]
        }
      )
    }
    // Step 1 (continued): `clientKind` is set from the authenticated device's own registry
    // `scope` at socket-auth time (runtime-rpc.ts) — `clientKind !== 'runtime'` above already
    // refuses a mobile-scope grant and a nonexistent row (no clientKind is set without one), so
    // no second DeviceRegistry lookup is needed here.

    // Step 2 (R27.2, Ruling 23 Addendum 3: rate -> containment): rate limit first — private
    // per-link namespace, own verb — so the one caller class already decided hostile does not
    // get an unbounded call rate ahead of the containment gate.
    const rate = runtime.getOrchestrationDb().checkAndBumpRate({
      subjectKey: `linkbind:${pairedDeviceId}`,
      verb: 'federatedLinkProbe',
      windowMs: LINK_BINDING_RATE_WINDOW_MS,
      limit: LINK_BINDING_RATE_LIMIT
    })
    if (!rate.allowed) {
      throw new OrchestrationError(
        'rate_limited',
        'Too many link-binding probes from this link; try again shortly.',
        { retryAfterMs: rate.retryAfterMs }
      )
    }

    // Step 3: link quarantine.
    refuseIfQuarantined(runtime, pairedDeviceId, 'probe')

    // Step 4: self-view (R9). A null accessor, or a null return from either member, refuses
    // `capability_unsupported` — never a fallback, never `'authenticated_transport'`.
    const selfView = runtime.linkBindingSelfView
    const observedChannelFp = selfView?.registryCredentialFingerprint(pairedDeviceId) ?? null
    const dstKeyFp = selfView?.ownKeyFingerprint() ?? null
    if (!selfView || observedChannelFp === null || dstKeyFp === null) {
      throw new OrchestrationError(
        'capability_unsupported',
        'This host cannot compute its own link-binding self-view right now.',
        { nextSteps: ['retry shortly; this host is missing its device registry or E2EE key'] }
      )
    }
    // Belt: when the caller's device token is directly visible, assert it hashes to the same
    // fingerprint we just derived from the registry row — a mismatch is impossible today (both
    // derive from the same authenticated device) but fails closed rather than silently.
    if (clientId && hashCallerCredential(clientId) !== observedChannelFp) {
      throw new OrchestrationError(
        'unauthenticated_lane',
        'The authenticated caller credential does not match this link’s registry fingerprint.'
      )
    }

    const byProbeId =
      pendingForRuntime(runtime).get(pairedDeviceId) ?? new Map<string, PendingAnswer>()
    pendingForRuntime(runtime).set(pairedDeviceId, byProbeId)
    const now = Date.now()
    pruneExpired(byProbeId, now)

    // Step 6: idempotency — an identical replay of a still-pending probeId returns the stored
    // results verbatim; the same probeId with different input is `request_mismatch`.
    const existing = byProbeId.get(params.probeId)
    if (existing) {
      const sameInput =
        existing.nonceH === params.nonceH &&
        existing.epoch === params.epoch &&
        existing.selectors.length === params.selectors.length &&
        existing.selectors.every((value, index) => value === params.selectors[index])
      if (sameInput) {
        return existing.results
      }
      throw new OrchestrationError(
        'request_mismatch',
        'This probeId was already used with different input.'
      )
    }

    const userDataPath = resolveUserDataPath()
    const buildFields = (slotIndex: number): string[] => [
      params.probeId,
      params.nonceH,
      String(slotIndex),
      String(params.epoch),
      observedChannelFp,
      dstKeyFp
    ]

    // Step 5: store precondition, in two outcomes (split R12.1(1), P6). Both refuse rather than
    // answering, closing v3's defect (an empty `results` array must never be readable as "I
    // scanned my whole store and hold nothing").
    const scan = scanEnvironmentsForSelectors(userDataPath, params.selectors, buildFields)
    if (scan.status === 'unreadable') {
      throw new OrchestrationError(
        'link_store_unreadable',
        'This host could not read its saved-environment store to answer a link-binding probe.',
        {
          nextSteps: [
            'this host cannot read its own saved-environment store right now; check its filesystem permissions and retry'
          ]
        }
      )
    }
    if (scan.status === 'empty') {
      throw new OrchestrationError(
        'link_store_empty',
        'This host has no saved environments to answer a link-binding probe against.',
        {
          nextSteps: [
            'this host has no saved environments to bind against; save at least one environment here first'
          ]
        }
      )
    }

    // Step 7/9: scan result → answer. Exactly one match ⇒ matched:true with a fresh proof.
    // >=2 matches ⇒ peer_duplicate, plus a local advisory observation. No match ⇒ nothing for
    // that slot.
    const results: FederatedLinkSlotResult[] = []
    const bySlot = new Map<number, PendingSlot>()
    const duplicateMatches: LinkBindingCandidate[][] = []
    for (const [slotIndex, matches] of scan.matchesBySlot) {
      if (matches.length >= 2) {
        results.push({ slotIndex, matched: false, reason: 'peer_duplicate' })
        duplicateMatches.push([...matches])
        continue
      }
      const [match] = matches
      if (!match) {
        continue
      }
      const nonceP = randomBytes(LINK_BINDING_NONCE_BYTES).toString('hex')
      const fields = [...buildFields(slotIndex), nonceP]
      const proof = computeCandidateMacFromEnvironments(
        scan.environments,
        match.environmentId,
        PROOF_LABEL,
        fields
      )
      if (proof === null) {
        // The environment vanished between the scan and now (a benign race) — omit the slot
        // rather than answering with a lie.
        continue
      }
      results.push({
        slotIndex,
        matched: true,
        nonceP,
        proof,
        observedChannelFp,
        peerKeyFingerprint: match.peerKeyFingerprint
      })
      bySlot.set(slotIndex, {
        environmentId: match.environmentId,
        nonceP,
        observedChannelFp,
        dstKeyFp
      })
    }

    for (const matches of duplicateMatches) {
      const detail = JSON.stringify({
        duplicateEnvironmentIds: matches.map((m) => m.environmentId)
      })
      for (const match of matches) {
        try {
          runtime.getOrchestrationDb().putConfirmObservation({
            linkDeviceId: pairedDeviceId,
            environmentId: match.environmentId,
            kind: 'local_duplicate',
            detail,
            observedAt: now
          })
        } catch (e) {
          // R14.5: at cap ⇒ link_binding_conflict is the write-side story; the probe answer
          // itself must still reach the peer, so a capped observation write is swallowed here.
          // Review F7: narrowed to the cap's own typed error; any other fault must propagate.
          if (!(e instanceof LinkBindingCapError)) {
            throw e
          }
        }
      }
      // Review F11 hygiene: `reason_code` holds short codes everywhere else in this table — the
      // full duplicate-environment-id JSON is already recorded per environment above, in each
      // `peer_link_confirm_observations.detail` row, so it is not repeated here.
      runtime.getOrchestrationDb().writeAgentAudit({
        agentId: null,
        actorPaneKey: null,
        actorHostId: pairedDeviceId,
        verb: 'federatedLink',
        outcome: 'peer_duplicate',
        reasonCode: null
      })
    }

    // Step 8: advisory — this responder's own finding on its own inbound link.
    const bindingRow = runtime.getOrchestrationDb().getPeerLinkBinding(pairedDeviceId)
    const responseResult: FederatedLinkProbeResult = {
      protocol: LINK_BINDING_PROTOCOL,
      results,
      ...(bindingRow?.state === 'contested' && bindingRow.contestIncidentId
        ? {
            advisory: { kind: 'link_contested' as const, incidentId: bindingRow.contestIncidentId }
          }
        : {})
    }

    // Review F5 / R8.3: supersession is a consequence of a probe being SERVED, not attempted — a
    // probe that ends in `link_store_empty`/`link_store_unreadable` (thrown above) must mutate
    // nothing, so this runs immediately before the successful answer is recorded, not at entry.
    releaseSuperseded(byProbeId, params.epoch)
    byProbeId.set(params.probeId, {
      createdAt: now,
      nonceH: params.nonceH,
      epoch: params.epoch,
      selectors: params.selectors,
      results: responseResult,
      bySlot
    })
    evictOldestIfOverCap(byProbeId)

    // R13.1: an authenticated inbound call is proof of liveness — tail of the handler, after the
    // probe has been fully dispositioned. Ruling 23(j)/FC-1: this NEVER resets the prover's own
    // `consecutive_failures` — it only clamps `next_attempt_after` to the per-link floor.
    runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'inbound_contact')

    return responseResult
  }
})
