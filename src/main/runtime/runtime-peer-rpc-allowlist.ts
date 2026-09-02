// S10-19 W-3/W-5 (chair rulings 20/22/24, INV-P-012/013/015): the peer RPC ingress boundary.
// W-3 lands the admission primitives the ingress and the two peer-only verbs need; the
// RUNTIME_PEER_RPC_METHOD_ALLOWLIST Map itself and the ingress block land in W-5 (§B ordering —
// no commit on this branch may mint a 'peer' grant that it does not already enforce).
import { isHostScopedId } from './orchestration/orchestration-id-grammar'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RemoteDispatchAttachmentRow } from './orchestration/types'
import {
  PEER_ATTACH_TIMEOUT_MAX_MS,
  PEER_ATTACH_TIMEOUT_MIN_MS,
  PEER_MAILBOX_PER_MINUTE
} from './peer-profile-constants'

// §D frozen refusal-code list. Wire error.code: 'rate_limited' for rate_limited, 'invalid_argument'
// for invalid_argument, 'forbidden' for everything else. peer_pane_rebound is internal-only (W-4)
// and is never constructed here.
export type PeerRefusalCode =
  | 'method_not_available'
  | 'admission_unavailable'
  | 'worktree_not_federated'
  | 'pane_not_peer_owned'
  | 'agent_not_live'
  | 'prompt_not_present'
  | 'prompt_state_unknown'
  | 'prompt_already_answered'
  | 'pane_write_unavailable'
  | 'attachment_cap_reached'
  | 'rate_limited'
  | 'run_not_shared'
  | 'run_wait_local_only'
  | 'invalid_argument'

export type PeerRefusal = {
  readonly refused: true
  readonly code: PeerRefusalCode
  readonly wireCode: 'forbidden' | 'rate_limited' | 'invalid_argument'
  readonly message: string
  readonly retryAfterMs?: number
}

export type PeerAdmission = { readonly refused: false }

// Why ONE builder: T-3 requires the five ownership refusals to be byte-identical — a second
// construction site is how that drifts.
export function peerRefusal(
  code: PeerRefusalCode,
  message: string,
  retryAfterMs?: number
): PeerRefusal {
  return {
    refused: true,
    code,
    wireCode: code === 'rate_limited' || code === 'invalid_argument' ? code : 'forbidden',
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  }
}

export const PEER_ADMITTED: PeerAdmission = { refused: false }

export type PeerAdmissionContext = {
  runtime: OrcaRuntimeService
  callerFingerprint: string
}

// S10-19 (ops MO-1 / attacker 6): db.checkAndBumpRate over one shared meter for every peer-link
// verb — PEER_MAILBOX_PER_MINUTE matches the federation inbound rate F9 already uses (Ruling 24
// addendum (j)). subjectKey is the caller's own fingerprint, so one peer's traffic never spends
// another peer's budget.
export function meterPeerLink(
  ctx: PeerAdmissionContext,
  verb: string
): PeerRefusal | PeerAdmission {
  const result = ctx.runtime.getOrchestrationDb().checkAndBumpRate({
    subjectKey: ctx.callerFingerprint,
    verb: `peer_link:${verb}`,
    windowMs: 60_000,
    limit: PEER_MAILBOX_PER_MINUTE
  })
  return result.allowed
    ? PEER_ADMITTED
    : peerRefusal('rate_limited', `Peer link rate limit exceeded for ${verb}.`, result.retryAfterMs)
}

// §4.1 (frozen predicate): new-top-level is admitted unconditionally (it names no pre-existing
// resource a peer could otherwise probe); current/new-child are refused outright (R2 — a peer
// dispatch never lands on a pane it did not create); an exact existing worktree is admitted only
// when its repo is on the (default-EMPTY, default-deny — G-4) federationDispatchRepos allowlist.
export type PeerDispatchTarget =
  | { kind: 'new-top-level' }
  | { kind: 'current' }
  | { kind: 'new-child' }
  | { kind: 'exact'; repoId: string }

export function assertPeerDispatchTarget(
  target: PeerDispatchTarget,
  federationDispatchRepos: readonly string[]
): PeerRefusal | PeerAdmission {
  if (target.kind === 'new-top-level') {
    return PEER_ADMITTED
  }
  if (target.kind === 'current' || target.kind === 'new-child') {
    return peerRefusal(
      'worktree_not_federated',
      'A federation peer may only dispatch to a new-top-level worktree or an allowlisted existing one.'
    )
  }
  return federationDispatchRepos.includes(target.repoId)
    ? PEER_ADMITTED
    : peerRefusal(
        'worktree_not_federated',
        `Repo ${target.repoId} is not on this host's federationDispatchRepos allowlist.`
      )
}

// RISK 1 (§0.2 / E.2): the peer-profile preamble is host-constant only once dispatchId/taskId are
// validated against the host's OWN id grammar — a preamble with taskSpec removed but a
// peer-chosen dispatchId still interpolated is not host-constant. Refuses invalid_argument,
// effect-free, before createRemoteDispatchAttachment ever runs.
export function assertPeerDispatchIds(params: {
  dispatchId: string
  taskId: string
}): PeerRefusal | PeerAdmission {
  if (!isHostScopedId(params.dispatchId, ['ctx'])) {
    return peerRefusal('invalid_argument', 'Dispatch ID is not a recognized host-minted id.')
  }
  if (!isHostScopedId(params.taskId, ['task'])) {
    return peerRefusal('invalid_argument', 'Task ID is not a recognized host-minted id.')
  }
  return PEER_ADMITTED
}

// §14B: an operator-supplied timeoutMs can only be SHORTENED from a peer-chosen value, never
// extended past the host's own ceiling — clamped, never refused (G-5: a validation threshold,
// not a refusal boundary).
export function clampPeerAttachTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return PEER_ATTACH_TIMEOUT_MAX_MS
  }
  return Math.min(Math.max(timeoutMs, PEER_ATTACH_TIMEOUT_MIN_MS), PEER_ATTACH_TIMEOUT_MAX_MS)
}

// §6.3 step 1 (attacker 6 / ops MO-1 — undefined in v5, defined here): the ownership test every
// peer-pane verb (W-4's choke, W-4's answer-prompt) starts from, minus the runtime reads those
// verbs each do themselves. Ends in the shared rate meter so every caller of this function is
// metered identically.
export function peerOwnedAttachmentOrRefusal(
  ctx: PeerAdmissionContext,
  dispatchId: string
): PeerRefusal | (PeerAdmission & { row: RemoteDispatchAttachmentRow }) {
  const row = ctx.runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (
    !row ||
    row.home_peer_fingerprint !== ctx.callerFingerprint ||
    row.agent_exited_at !== null ||
    row.state === 'agent_exited' ||
    !row.terminal_handle ||
    row.runtime_epoch !== ctx.runtime.getRuntimeId()
  ) {
    return peerRefusal(
      'pane_not_peer_owned',
      `Dispatch ${dispatchId} is not a live peer-owned pane on this runtime.`
    )
  }
  const metered = meterPeerLink(ctx, 'prompt')
  if (metered.refused) {
    return metered
  }
  return { refused: false, row }
}
