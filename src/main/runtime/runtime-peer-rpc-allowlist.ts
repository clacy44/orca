// S10-19 W-3/W-5 (chair rulings 20/22/24, INV-P-012/013/015): the peer RPC ingress boundary.
// W-3 lands the admission primitives the ingress and the two peer-only verbs need; the
// RUNTIME_PEER_RPC_METHOD_ALLOWLIST Map itself and the ingress block land in W-5 (§B ordering —
// no commit on this branch may mint a 'peer' grant that it does not already enforce).
import { isHostScopedId } from './orchestration/orchestration-id-grammar'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RemoteDispatchAttachmentRow } from './orchestration/types'
import {
  PEER_ATTACH_PER_MINUTE,
  PEER_ATTACH_TIMEOUT_DEFAULT_MS,
  PEER_ATTACH_TIMEOUT_MAX_MS,
  PEER_ATTACH_TIMEOUT_MIN_MS,
  PEER_LIVE_ATTACHMENTS_PER_LINK,
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
  // W-5: the raw request params, needed by the ingress-level admission predicates
  // (federationAttachStart's params.terminal refusal, federationAnswerPrompt's dispatchId
  // extraction). Optional so W-3/W-4's narrower call sites (which never construct it) keep
  // compiling unchanged.
  params?: unknown
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

// Ruling 24 addendum (h): name/repo/displayName/comment length-capped and charset-bounded at
// ingress, same enforce-before-mint ordering as assertPeerDispatchIds — none of these reaches
// createManagedWorktree (git branch/repo selection, stored display metadata) unchecked.
const PEER_WORKTREE_METADATA_MAX_LENGTH: Record<
  'name' | 'repo' | 'displayName' | 'comment',
  number
> = {
  name: 200,
  repo: 200,
  displayName: 200,
  comment: 2000
}

// Every C0 control (0x00-0x1F, includes tab/LF/CR) plus DEL — never a legitimate byte in a
// name/repo/displayName/comment string; a newline in particular is how free text turns into a
// second shell/log line.
// eslint-disable-next-line no-control-regex -- matching control bytes IS the point: refusing them at ingress.
const PEER_WORKTREE_METADATA_CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

export function assertPeerWorktreeMetadataBounded(params: {
  name?: string
  repo?: string
  displayName?: string
  comment?: string
}): PeerRefusal | PeerAdmission {
  for (const field of ['name', 'repo', 'displayName', 'comment'] as const) {
    const value = params[field]
    if (value === undefined) {
      continue
    }
    const max = PEER_WORKTREE_METADATA_MAX_LENGTH[field]
    if (value.length > max) {
      return peerRefusal(
        'invalid_argument',
        `${field} exceeds the ${max}-character bound for a federation peer.`
      )
    }
    if (PEER_WORKTREE_METADATA_CONTROL_CHAR_RE.test(value)) {
      return peerRefusal('invalid_argument', `${field} contains a disallowed control character.`)
    }
  }
  return PEER_ADMITTED
}

// §14B: an operator-supplied timeoutMs can only be SHORTENED from a peer-chosen value, never
// extended past the host's own ceiling — clamped, never refused (G-5: a validation threshold,
// not a refusal boundary).
export function clampPeerAttachTimeoutMs(timeoutMs: number | undefined): number {
  // Review finding 8: absent/non-finite is "the peer said nothing" — the plain 60s default, not
  // the 180s ceiling. Only a SUPPLIED value is clamped into [MIN, MAX].
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return PEER_ATTACH_TIMEOUT_DEFAULT_MS
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

// ── W-5: the ingress filter, the allowlist literal, per-verb hardening, metering ──────────────

const p = (params: unknown): Record<string, unknown> =>
  params && typeof params === 'object' ? (params as Record<string, unknown>) : {}

// §D: an unreadable store, a resolver fault, or any other throw from an admission predicate
// refuses this ONE call with a typed, effect-free reply and an audit row — it never drops the
// frame (an unhandled rejection reads as no response at all) and it never admits (§3 prereq 5).
export const REFUSE_ADMISSION_UNAVAILABLE: PeerRefusal = peerRefusal(
  'admission_unavailable',
  'The peer admission check is temporarily unavailable; retry shortly.'
)

export function recordPeerAdmissionFault(
  ctx: PeerAdmissionContext & { method: string },
  error: unknown
): void {
  try {
    ctx.runtime.getOrchestrationDb().writeAgentAudit({
      agentId: null,
      actorPaneKey: null,
      actorHostId: ctx.callerFingerprint,
      verb: `peer_link:${ctx.method}`,
      outcome: 'admission_unavailable',
      reasonCode: error instanceof Error ? error.message.slice(0, 200) : 'unknown_fault'
    })
  } catch {
    // Why: the audit write itself must never be the reason a refusal fails to reach the wire.
  }
}

// §5 (Ruling 20 CORE RULING, R13/R30.3): S10-16 registers `federatedLinkProbe`/`federatedLinkConfirm`
// as peer-by-design verbs. They do not exist at this branch's HEAD (git grep -> 0 hits), so S-1
// exempts them from the "every allowlist entry resolves to a registered method" check and S-5
// asserts this set is empty once ALL_RPC_METHODS actually contains them (i.e. once S10-16 lands
// — whichever slice merges second carries the other's entries in the same commit, §11).
export const RESERVED_PENDING_S10_16: ReadonlySet<string> = new Set([
  'orchestration.federatedLinkProbe',
  'orchestration.federatedLinkConfirm'
])

// §8.6: one flat meter per verb "subject" for every peer-link verb OTHER than attach, which gets
// its own PEER_ATTACH_PER_MINUTE budget below so a metered read (status/roster) can't starve a
// dispatch attempt, and vice versa.
function meteredOnly(subject: string): (ctx: PeerAdmissionContext) => PeerRefusal | PeerAdmission {
  return (ctx) => meterPeerLink(ctx, subject)
}

// §4.1/§4.1a/R7/R15: the ingress-level bound on `orchestration.federationAttachStart` for a peer
// caller. The worktree-target and dispatch-id-grammar predicates are already enforced INSIDE the
// handler (orchestration-federation.ts, W-3) because they need the resolved managed-worktree
// record; this predicate covers what the handler does not: no caller-named pane (R7 — refused
// here, effect-free, before any row exists), the per-link live-attachment cap
// (PEER_LIVE_ATTACHMENTS_PER_LINK), and the attach verb's own rate budget
// (PEER_ATTACH_PER_MINUTE, distinct from the general PEER_MAILBOX_PER_MINUTE meter).
function federatedAttachAdmission(ctx: PeerAdmissionContext): PeerRefusal | PeerAdmission {
  if (p(ctx.params).terminal !== undefined) {
    return peerRefusal(
      'worktree_not_federated',
      'A federation peer may not name a pane to attach to; omit --terminal.'
    )
  }
  const live = ctx.runtime.getOrchestrationDb().countLivePeerAttachments(ctx.callerFingerprint)
  if (live >= PEER_LIVE_ATTACHMENTS_PER_LINK) {
    return peerRefusal(
      'attachment_cap_reached',
      `This link already holds ${live} live peer attachments (cap ${PEER_LIVE_ATTACHMENTS_PER_LINK}).`
    )
  }
  const result = ctx.runtime.getOrchestrationDb().checkAndBumpRate({
    subjectKey: ctx.callerFingerprint,
    verb: 'peer_link:attach',
    windowMs: 60_000,
    limit: PEER_ATTACH_PER_MINUTE
  })
  return result.allowed
    ? PEER_ADMITTED
    : peerRefusal('rate_limited', 'Peer link attach rate limit exceeded.', result.retryAfterMs)
}

// §6.4: admitted here only on shape (a well-formed dispatchId). Ownership, prompt liveness and
// the single-shot reservation are decided inside writeToPeerOwnedPane (W-4) under the PTY
// write's own serialization — that function already calls peerOwnedAttachmentOrRefusal itself
// (which ends in meterPeerLink), so re-running it here would meter the same call twice.
function peerPromptAnswerAdmission(ctx: PeerAdmissionContext): PeerRefusal | PeerAdmission {
  return typeof p(ctx.params).dispatchId === 'string'
    ? PEER_ADMITTED
    : peerRefusal('pane_not_peer_owned', 'Missing dispatchId.')
}

export type PeerRpcAdmissionRule =
  | true
  | ((ctx: PeerAdmissionContext) => PeerRefusal | PeerAdmission)

// The 20-entry literal (§5/§D, FROZEN): 11 admitted on the name alone, 7 conditional
// (status.get, federationAttachStart, check, send, reply, terminal.list,
// federationAnswerPrompt), 2 reserved for S10-16 (peer-by-design; not registered on this
// branch). An absent key is a refusal — default-deny. `orchestration.federationWorkerInput`
// does not exist and appears nowhere here (S-8).
export const RUNTIME_PEER_RPC_METHOD_ALLOWLIST = new Map<string, PeerRpcAdmissionRule>([
  // ── 1. capability negotiation ─────────────────────────────────────────────
  ['status.get', meteredOnly('status')],

  // ── 2. federated worker lifecycle (this host is the WORKER SERVER) ────────
  ['orchestration.federationAttachStart', federatedAttachAdmission],
  ['orchestration.federationPull', true],
  ['orchestration.federationAck', true],
  ['orchestration.federationImport', true],
  ['orchestration.federationShow', true],
  ['orchestration.federationRead', true],
  ['orchestration.federationReadOutput', true],
  ['orchestration.federationStop', true],

  // ── 3. chair-to-chair mail ────────────────────────────────────────────────
  ['orchestration.federatedAsk', true],
  ['orchestration.federatedSend', true],

  // ── 4. remote run mailbox — the mode assertion + body-identity refusal live in the handler
  // (orchestration.ts, W-5) because they need the parsed, typed params; admitted here on name.
  ['orchestration.check', true],
  ['orchestration.send', true],
  ['orchestration.reply', true],

  // ── 5. roster and directory (read-only, projected / metered) ──────────────
  ['terminal.list', meteredOnly('roster')],
  ['orchestration.agents.list', true],
  ['orchestration.agents.get', true],

  // ── 6. the only peer input into a pane (Ruling 20 CORE RULING) ────────────
  ['orchestration.federationAnswerPrompt', peerPromptAnswerAdmission],

  // ── 7. S10-16 link binding — peer-by-design (R13, Ruling 14f) ─────────────
  ['orchestration.federatedLinkProbe', true],
  ['orchestration.federatedLinkConfirm', true]
])

// §3, the ingress boundary. `runtime-rpc.ts` awaits this for every peer-profile WS request
// before dispatch. Cannot throw (MJ-5/R3): a throw here would be an unhandled rejection with no
// frame written, which is the unknown-outcome R17/M10 exist to prevent.
export async function admitRuntimePeerMethod(
  ctx: PeerAdmissionContext & { method: string }
): Promise<PeerAdmission | PeerRefusal> {
  try {
    const rule = RUNTIME_PEER_RPC_METHOD_ALLOWLIST.get(ctx.method)
    if (rule === undefined) {
      return peerRefusal(
        'method_not_available',
        `Method '${ctx.method}' is not available to a federation-peer grant.`
      )
    }
    if (rule === true) {
      return PEER_ADMITTED
    }
    return rule(ctx)
  } catch (error) {
    recordPeerAdmissionFault(ctx, error)
    return REFUSE_ADMISSION_UNAVAILABLE
  }
}
