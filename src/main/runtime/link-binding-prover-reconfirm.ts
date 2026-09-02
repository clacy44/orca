// S10-16 C4a, R10-E (design v6, plan §C4 "probe -> classify -> re-probe -> confirm"): the winner
// re-probe + batched federatedLinkConfirm that must succeed BEFORE prover-settle.ts writes
// peer_link_bindings. Split into its own module (Ruling 23(m): a SPLIT is the only remedy for
// the 300-line gate; a baseline entry is forbidden) — `runOneRound` is the only caller.
//
// Shape: group this round's bind-family winners by their winning environment (one re-probe +
// one batched confirm per environment, not per link); mint a FRESH probeId/nonceH (R10-E's "own
// nonce"); re-probe that environment ALONE; verify each returned proof exactly as the original
// probe pass does; compute the CONFIRM_LABEL MAC for every re-verified slot and send them in one
// federatedLinkConfirm call; a link's binding may be written iff its own slotIndex appears in
// that call's `acknowledged` array. Any failure (transport error, busy, protocol violation, an
// empty confirm) fails every link in that environment's group — no partial credit is invented.
import { randomBytes } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type { LinkBindingSelfView } from './device-registry-link-credential'
import {
  LINK_BINDING_PROTOCOL,
  SELECTOR_LABEL,
  PROOF_LABEL,
  CONFIRM_LABEL,
  LINK_BINDING_HEX64_RE,
  linkBindingMacEquals
} from './orchestration/link-binding-proof'
import {
  LINK_BINDING_PROBE_SLOTS,
  LINK_BINDING_NONCE_BYTES,
  LINK_BINDING_HEX32_LENGTH,
  LINK_BINDING_RPC_BUDGET_MS
} from './orchestration/link-binding-constants'
import type { LinkRoundWinner } from './orchestration/link-binding-classify'
import { parseProbeResults } from './link-binding-prover-outcome'
import type { GuardedProbe } from './link-binding-prover-probe'

export type ReconfirmCandidate = { linkDeviceId: string; winner: LinkRoundWinner }

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

function parseAcknowledged(raw: unknown): number[] | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const ack = (raw as { acknowledged?: unknown }).acknowledged
  if (!Array.isArray(ack) || !ack.every((v) => typeof v === 'number' && Number.isInteger(v))) {
    return null
  }
  return ack as number[]
}

// R10-E: every link in `candidates` whose classification this round is bind-family. Returns
// which of them survived the re-probe + confirm — absent from the map only for a link this
// function was never asked about.
export async function reconfirmWinners(args: {
  runtime: OrcaRuntimeService
  selfView: LinkBindingSelfView
  guardedProbe: GuardedProbe
  roundEpoch: number
  candidates: ReconfirmCandidate[]
}): Promise<Map<string, boolean>> {
  const { runtime, selfView, guardedProbe, roundEpoch, candidates } = args
  const confirmed = new Map<string, boolean>()
  const byEnvironment = new Map<string, ReconfirmCandidate[]>()
  for (const candidate of candidates) {
    const group = byEnvironment.get(candidate.winner.environmentId)
    if (group) {
      group.push(candidate)
    } else {
      byEnvironment.set(candidate.winner.environmentId, [candidate])
    }
  }
  for (const [environmentId, group] of byEnvironment) {
    const ok = await reconfirmOneEnvironment({
      runtime,
      selfView,
      guardedProbe,
      roundEpoch,
      environmentId,
      group
    })
    for (const candidate of group) {
      confirmed.set(candidate.linkDeviceId, ok.has(candidate.linkDeviceId))
    }
  }
  return confirmed
}

async function reconfirmOneEnvironment(args: {
  runtime: OrcaRuntimeService
  selfView: LinkBindingSelfView
  guardedProbe: GuardedProbe
  roundEpoch: number
  environmentId: string
  group: ReconfirmCandidate[]
}): Promise<Set<string>> {
  const { runtime, selfView, guardedProbe, roundEpoch, environmentId, group } = args
  const confirmedLinkIds = new Set<string>()
  const first = group[0]
  if (!first) {
    return confirmedLinkIds
  }
  // Every candidate in a group shares one winning environment, so it shares that environment's
  // own observed credential/key fingerprints and pairing revision (properties of the ENVIRONMENT,
  // not of any one link).
  const observedChannelFp = first.winner.peerCredentialFp
  const dstKeyFp = first.winner.peerKeyFingerprint
  const expectedRevision = first.winner.boundPairingRevision

  const probeId = randomHex(LINK_BINDING_HEX32_LENGTH / 2)
  const nonceH = randomHex(LINK_BINDING_NONCE_BYTES)
  const selectors: string[] = group.map(
    (candidate, idx) =>
      selfView.macWithRegistryToken(candidate.linkDeviceId, SELECTOR_LABEL, [
        probeId,
        nonceH,
        String(idx),
        String(roundEpoch),
        observedChannelFp,
        dstKeyFp
      ]) ?? randomHex(LINK_BINDING_NONCE_BYTES)
  )
  while (selectors.length < LINK_BINDING_PROBE_SLOTS) {
    selectors.push(randomHex(LINK_BINDING_NONCE_BYTES))
  }

  let probed: unknown
  try {
    probed = await guardedProbe(environmentId, LINK_BINDING_RPC_BUDGET_MS, () =>
      runtime.callPinnedEnvironment({
        selector: environmentId,
        method: 'orchestration.federatedLinkProbe',
        params: { protocol: LINK_BINDING_PROTOCOL, probeId, nonceH, epoch: roundEpoch, selectors },
        timeoutMs: LINK_BINDING_RPC_BUDGET_MS,
        maxDurationMs: LINK_BINDING_RPC_BUDGET_MS,
        expectedEnvironmentPairingRevision: expectedRevision,
        requireOrchestrationContract: false
      })
    )
  } catch {
    return confirmedLinkIds
  }
  if (probed === 'busy') {
    return confirmedLinkIds
  }
  const parsed = parseProbeResults(probed)
  if (parsed === null) {
    return confirmedLinkIds
  }

  const confirmsBySlot: { slotIndex: number; confirm: string; linkDeviceId: string }[] = []
  for (const result of parsed) {
    if (!result.matched) {
      continue
    }
    const candidate = group[result.slotIndex]
    if (!candidate) {
      continue
    }
    const fields = [
      probeId,
      nonceH,
      String(result.slotIndex),
      String(roundEpoch),
      observedChannelFp,
      dstKeyFp,
      result.nonceP
    ]
    const expectedProof = selfView.macWithRegistryToken(candidate.linkDeviceId, PROOF_LABEL, fields)
    if (
      expectedProof === null ||
      !LINK_BINDING_HEX64_RE.test(result.proof) ||
      !linkBindingMacEquals(expectedProof, result.proof)
    ) {
      continue
    }
    const confirm = selfView.macWithRegistryToken(candidate.linkDeviceId, CONFIRM_LABEL, fields)
    if (confirm === null) {
      continue
    }
    confirmsBySlot.push({
      slotIndex: result.slotIndex,
      confirm,
      linkDeviceId: candidate.linkDeviceId
    })
  }
  if (confirmsBySlot.length === 0) {
    return confirmedLinkIds
  }

  let confirmResult: unknown
  try {
    confirmResult = await guardedProbe(environmentId, LINK_BINDING_RPC_BUDGET_MS, () =>
      runtime.callPinnedEnvironment({
        selector: environmentId,
        method: 'orchestration.federatedLinkConfirm',
        params: {
          protocol: LINK_BINDING_PROTOCOL,
          probeId,
          confirms: confirmsBySlot.map((c) => ({ slotIndex: c.slotIndex, confirm: c.confirm }))
        },
        timeoutMs: LINK_BINDING_RPC_BUDGET_MS,
        maxDurationMs: LINK_BINDING_RPC_BUDGET_MS,
        expectedEnvironmentPairingRevision: expectedRevision,
        requireOrchestrationContract: false
      })
    )
  } catch {
    return confirmedLinkIds
  }
  if (confirmResult === 'busy') {
    return confirmedLinkIds
  }
  const acknowledged = parseAcknowledged(confirmResult)
  if (acknowledged === null || acknowledged.length === 0) {
    return confirmedLinkIds
  }
  const ackSet = new Set(acknowledged)
  for (const c of confirmsBySlot) {
    if (ackSet.has(c.slotIndex)) {
      confirmedLinkIds.add(c.linkDeviceId)
    }
  }
  return confirmedLinkIds
}
