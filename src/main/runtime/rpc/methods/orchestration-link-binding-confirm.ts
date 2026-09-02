// S10-16 C3, R7.4/R7.5 (design v6, frozen): the `orchestration.federatedLinkConfirm` handler body
// — split out of orchestration-link-binding-peer.ts to stay under the max-lines ratchet. A confirm
// writes NO binding and NO scan fact — one confirm-observations row, advisory only.
import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { isUnauthenticatedLaneCallerFingerprint } from '../../orchestration/db'
import {
  LINK_BINDING_PROTOCOL,
  CONFIRM_LABEL,
  linkBindingMacEquals
} from '../../orchestration/link-binding-proof'
import {
  LINK_BINDING_RATE_WINDOW_MS,
  LINK_BINDING_RATE_LIMIT
} from '../../orchestration/link-binding-constants'
import { computeCandidateMac } from '../../../ipc/runtime-environment-link-binding'
import {
  resolveUserDataPath,
  pendingForRuntime,
  pruneExpired,
  refuseIfQuarantined
} from './orchestration-link-binding-pending'
import {
  FederatedLinkConfirmParams,
  type FederatedLinkConfirmResult
} from './orchestration-link-binding-wire'

export const FEDERATED_LINK_CONFIRM_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.federatedLinkConfirm',
  params: FederatedLinkConfirmParams,
  handler: async (
    params,
    { runtime, pairedDeviceId, clientKind, authenticatedCallerFingerprint }
  ) => {
    if (
      !pairedDeviceId ||
      clientKind !== 'runtime' ||
      isUnauthenticatedLaneCallerFingerprint(authenticatedCallerFingerprint)
    ) {
      throw new OrchestrationError(
        'unauthenticated_lane',
        'Link-binding confirms require an authenticated paired-runtime link, not a local caller.',
        {
          nextSteps: [
            'this call must arrive over a paired runtime link, never a local pane or an old CLI — re-pair the two hosts if this persists'
          ]
        }
      )
    }

    refuseIfQuarantined(runtime, pairedDeviceId, 'confirm')

    const rate = runtime.getOrchestrationDb().checkAndBumpRate({
      subjectKey: `linkbind:${pairedDeviceId}`,
      verb: 'federatedLinkConfirm',
      windowMs: LINK_BINDING_RATE_WINDOW_MS,
      limit: LINK_BINDING_RATE_LIMIT
    })
    if (!rate.allowed) {
      throw new OrchestrationError(
        'rate_limited',
        'Too many link-binding confirms from this link; try again shortly.',
        { retryAfterMs: rate.retryAfterMs }
      )
    }

    const seen = new Set<number>()
    for (const entry of params.confirms) {
      if (seen.has(entry.slotIndex)) {
        throw new OrchestrationError(
          'invalid_argument',
          'Duplicate slotIndex in one federatedLinkConfirm call.'
        )
      }
      seen.add(entry.slotIndex)
    }

    const byProbeId = pendingForRuntime(runtime).get(pairedDeviceId)
    const now = Date.now()
    if (byProbeId) {
      pruneExpired(byProbeId, now)
    }
    const pending = byProbeId?.get(params.probeId)
    if (!pending) {
      // R8.5: a confirm arriving on a different link than its probe, or past TTL, or already
      // consumed, finds nothing. Non-fatal to H — H's binding is already written.
      throw new OrchestrationError(
        'not_the_addressee',
        'No pending link-binding probe matches this probeId on this link.'
      )
    }

    const userDataPath = resolveUserDataPath()
    const acknowledged: number[] = []
    for (const entry of params.confirms) {
      const slot = pending.bySlot.get(entry.slotIndex)
      if (!slot) {
        continue
      }
      const fields = [
        params.probeId,
        pending.nonceH,
        String(entry.slotIndex),
        String(pending.epoch),
        slot.observedChannelFp,
        slot.dstKeyFp,
        slot.nonceP
      ]
      const expected = computeCandidateMac(userDataPath, slot.environmentId, CONFIRM_LABEL, fields)
      if (expected !== null && linkBindingMacEquals(expected, entry.confirm)) {
        acknowledged.push(entry.slotIndex)
        try {
          // R7.5: a confirm writes NO binding and NO scan fact — one confirm-observations row,
          // advisory only, single-writer (this responder). C4's link-binding-prover.ts (not yet
          // landed in this commit) is what schedules this host's own proof round on the back of
          // a confirm; that wiring is deferred to C4 (see this commit's return notes).
          runtime.getOrchestrationDb().putConfirmObservation({
            linkDeviceId: pairedDeviceId,
            environmentId: slot.environmentId,
            kind: 'peer_confirmed',
            detail: null,
            observedAt: now
          })
        } catch {
          // R14.5: capped — the acknowledgement still stands even if the observation row does not.
        }
      }
    }

    // Consume the pending record on first use, regardless of outcome (R8.5).
    byProbeId?.delete(params.probeId)

    if (acknowledged.length === 0) {
      throw new OrchestrationError(
        'not_the_addressee',
        'No confirmed slot verified against this link’s pending probe.'
      )
    }

    const result: FederatedLinkConfirmResult = { protocol: LINK_BINDING_PROTOCOL, acknowledged }
    return result
  }
})
