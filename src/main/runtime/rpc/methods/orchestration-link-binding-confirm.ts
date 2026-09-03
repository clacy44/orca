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
import {
  loadEnvironmentsForLinkBinding,
  computeCandidateMacFromEnvironments
} from '../../../ipc/runtime-environment-link-binding'
import { LinkBindingCapError } from '../../orchestration/link-binding-store'
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

    // R27.2 (Ruling 23 Addendum 3): rate -> containment.
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

    refuseIfQuarantined(runtime, pairedDeviceId, 'confirm')

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
    // Review F9: read/parse the store ONCE per call, not once per confirm entry (up to 8).
    const environments = loadEnvironmentsForLinkBinding(userDataPath) ?? []
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
      const expected = computeCandidateMacFromEnvironments(
        environments,
        slot.environmentId,
        CONFIRM_LABEL,
        fields
      )
      if (expected !== null && linkBindingMacEquals(expected, entry.confirm)) {
        acknowledged.push(entry.slotIndex)
        try {
          // R7.5: a confirm writes NO binding and NO scan fact — one confirm-observations row,
          // advisory only, single-writer (this responder).
          runtime.getOrchestrationDb().putConfirmObservation({
            linkDeviceId: pairedDeviceId,
            environmentId: slot.environmentId,
            kind: 'peer_confirmed',
            detail: null,
            observedAt: now
          })
        } catch (e) {
          // R14.5: capped — the acknowledgement still stands even if the observation row does not.
          // Review F7: narrowed to the cap's own typed error; any other fault (schema, CHECK, IO)
          // must propagate rather than yield a successful acknowledgement with no signal.
          if (!(e instanceof LinkBindingCapError)) {
            throw e
          }
        }
      }
    }

    // Review F3 / R7.4 (design v6:1360): "if none verify => not_the_addressee, no state change."
    // Consume the pending record ONLY when at least one slot verified — a total miss (any party
    // authenticated on the link, including a duplicated-credential holder) must not be able to
    // burn a legitimate in-flight handshake with one well-formed but wrong confirm.
    if (acknowledged.length === 0) {
      throw new OrchestrationError(
        'not_the_addressee',
        'No confirmed slot verified against this link’s pending probe.'
      )
    }
    byProbeId?.delete(params.probeId)

    // R7.5/R13.1: schedule THIS host's own proof round against the peer that just confirmed —
    // after the confirm is fully dispositioned, once per call (not per acknowledged slot).
    runtime.getLinkBindingProver().scheduleBinding(pairedDeviceId, 'peer_confirmed')

    const result: FederatedLinkConfirmResult = { protocol: LINK_BINDING_PROTOCOL, acknowledged }
    return result
  }
})
