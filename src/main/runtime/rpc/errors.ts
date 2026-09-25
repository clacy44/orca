// Why: every RPC response needs the same runtimeId envelope, and the
// runtime/browser error allowlists define the contract the CLI relies on to
// format human-facing messages. Centralizing this mapping keeps the allowlist
// auditable in one place instead of spread across per-method branches.
import type { RpcEnvelopeMeta, RpcFailure, RpcSuccess } from './core'
import { computerUseErrorRecoveryData } from '../../../shared/computer-use-error-recovery'
import { COMPUTER_ERROR_CODES } from '../../../shared/runtime-types'
import { LINEAR_ERROR_CODES } from '../../../shared/linear/agent-access'
import { AGENT_SESSION_RPC_ERROR_CODES } from '../../../shared/agent-session-host-authority'
import { ARTIFACT_SHARING_DISABLED_CODE } from '../../../shared/artifact-sharing-gate'
import { GIT_DIFF_TOO_LARGE_CODE } from '../../../shared/git-diff-transport-budget'
import { CLAUDE_LANE_REFUSAL_CODES } from '../../../shared/claude-lane-refusals'

export function successResponse(id: string, meta: RpcEnvelopeMeta, result: unknown): RpcSuccess {
  return {
    id,
    ok: true,
    result,
    _meta: meta
  }
}

export function errorResponse(
  id: string,
  meta: RpcEnvelopeMeta,
  code: string,
  message: string,
  data?: unknown
): RpcFailure {
  return {
    id,
    ok: false,
    error: data === undefined ? { code, message } : { code, message, data },
    _meta: meta
  }
}

// Why: the OrcaRuntimeService throws plain Error objects whose `message` is
// actually a stable error code. This allowlist is the contract the CLI relies
// on — expanding or renaming entries without updating the CLI would silently
// change user-visible error codes.
const RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'runtime_unavailable',
  'selector_not_found',
  'selector_ambiguous',
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_exited',
  'terminal_gone',
  'terminal_tab_close_timeout',
  'terminal_tab_not_found',
  'terminal_tab_pinned',
  'no_active_terminal',
  'repo_not_found',
  'timeout',
  'invalid_limit',
  'remote_update_manual_required',
  'remote_update_not_available',
  'remote_update_not_downloaded',
  ...AGENT_SESSION_RPC_ERROR_CODES
])

const COMPUTER_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(Object.values(COMPUTER_ERROR_CODES))
const LINEAR_PASSTHROUGH_CODES: ReadonlySet<string> = new Set(LINEAR_ERROR_CODES)
const STRUCTURED_RUNTIME_PASSTHROUGH_CODES: ReadonlySet<string> = new Set([
  'worktree_id_requires_full_path',
  'run_not_found',
  'run_required',
  'stable_pane_required',
  'consumer_fenced',
  'task_not_found',
  'task_not_startable',
  'dispatch_not_found',
  'dispatch_run_mismatch',
  'dispatch_inactive',
  'worker_identity_changed',
  'cursor_invalid',
  'cursor_dispatch_mismatch',
  'source_changed',
  'transcript_required',
  'server_required',
  'worktree_not_found_on_server',
  'resource_server_mismatch',
  'peer_changed',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'invalid_runtime_response',
  'capability_unsupported',
  'relay_quota_exceeded',
  'dispatch_capability_invalid',
  'agent_unconfigured',
  'terminal_worktree_mismatch',
  'request_mismatch',
  'mutation_ledger_full',
  'legacy_read_only',
  'orchestration_migration_required',
  'operation_unknown',
  'question_not_found',
  'answer_conflict',
  'stale_delivery',
  'waiter_exists',
  'remote_mailbox_unpaired',
  'invalid_argument',
  GIT_DIFF_TOO_LARGE_CODE,
  ARTIFACT_SHARING_DISABLED_CODE,
  // Why: every lane refusal carries a complete human sentence; the client has no code table for
  // them, so the code must pass through with its message rather than collapse to runtime_error.
  ...CLAUDE_LANE_REFUSAL_CODES,
  // S10-1/S10-2b: agent-directory and containment refusals, all thrown with `data.nextSteps` a
  // caller (CLI or programmatic) needs verbatim — collapsing to runtime_error would erase both
  // the discriminator and the recovery guidance. no_pane_identity/agent_quarantined/
  // agent_unknown/derived_agent_unaddressable predate S10-2b (orchestration-agents-*.ts,
  // orchestration.ts send's `agent:` guard) but were never exercised through the real
  // dispatcher in tests until this series' hardened orchestration.thread/peer ask-reply
  // coverage caught the gap; the rest are new S10-2b codes.
  'no_pane_identity',
  // S10-15 D6: the pane IS attested but has no registered `agents` row — a distinct code from
  // no_pane_identity so the CLI's auto-reattest gate (keyed on exact code equality) never fires
  // for a case reattestation cannot fix.
  'no_registered_identity',
  'agent_quarantined',
  'agent_unknown',
  'derived_agent_unaddressable',
  // S10-15 F6 (finding 18/D8): `agent_retired` (addressable-agent-recipient.ts) was omitted when
  // S10-7 F-B added it — same family as the three above, and its nextSteps carry the successor
  // agent's id, which the runtime_error fallthrough dropped.
  'agent_retired',
  // S10-15 finding 18: two more codes reachable from the same new hot paths (federatedAsk's
  // auth-lane check, every stale-environment relay) whose structured data (nextSteps /
  // retryAfterMs) the runtime_error fallthrough would otherwise drop.
  'unauthenticated_lane',
  'stale_environment_pairing',
  'rate_limited',
  // R223b: the bus-poll guard's refusal code; carries retryAfterMs/limit/windowMs/nextSteps.
  'polling_detected',
  'payload_kind_reserved',
  'body_gate_refused',
  'not_a_participant',
  'not_the_addressee',
  'dispatch_never_federated',
  // S10-19 R24 (§8.7): a peer's orchestration.check --wait against a locally-bound Run — the
  // CLI needs the distinct code, not a collapsed runtime_error, to print the right guidance.
  'run_wait_local_only',
  // S10-11 R1/R4: thrown with `data.nextSteps` a caller acts on verbatim (name_taken's
  // alternative-name suggestion; message_not_found's cross-host --environment hint) — same
  // reasoning as the S10-2b block above, just not caught by dispatcher-level tests until now.
  'name_taken',
  'message_not_found',
  // S10-12 R1: daemon-attested-absent pty refusal, thrown with `data.nextSteps` — same
  // reasoning as the S10-2b block above (a discriminator + recovery guidance a caller acts on).
  'no_connected_pty',
  // Pre-existing gaps also caught by this series' containment RPC tests: `not_found` and
  // `forbidden` are the quarantine/purge/review authority codes (orchestration-agents-
  // quarantine.ts predates S10-2b; orchestration-containment.ts is new).
  'not_found',
  'forbidden',
  // S10-15 (chair ruling 7): thrown by orchestration.reply against a foreign-origin message row
  // (no automatic route resolution — R9 was cut) with `data.nextSteps` naming the working path.
  'no_return_route',
  // S10-16 R25: exactly three new link-binding codes, each with a self-contained guidance
  // sentence at its throw site (principal-lane-consent-service.ts:210-213's rule) — an old
  // client has no string for a new code. `protocol_violation` is deliberately NOT added here
  // (Ruling 23(f)): it is a local `peer_link_scan_facts.outcome` CHECK member only, never a wire
  // code, and its absence from this set is load-bearing for R23 point 3 (`method_not_found`
  // staying unpropagated).
  'link_binding_conflict',
  'link_store_unreadable',
  'link_store_empty',
  // S10-22a WAVE 2 (b1-slice1-succession.md §"Wave 2 contract"): chair succession's typed
  // refusals, each a complete sentence the CLI prints verbatim with next steps where the brief
  // names them (`succession_unacked_delivery`'s `ids`, checkpoint_*'s `line`).
  'succession_not_a_chair',
  'succession_no_run',
  'succession_legacy_run',
  'succession_active_dispatch',
  'succession_in_flight',
  'succession_charter_missing',
  'succession_unacked_delivery',
  'succession_unknown',
  'succession_wrong_pane',
  'succession_not_launching',
  'succession_expired',
  'succession_takeover_failed',
  'succession_none',
  // G1 repair round (b2-g1-repairs.md; findings B5/L3/L4/M1/M8): typed refusals reachable only
  // after the wave 2 contract's first pass, added additively.
  'resume_context_too_large',
  'succession_run_moved',
  'succession_unknown_ack',
  'succession_incumbent_exit_timeout',
  // Judgment call (see RETURN): not in the brief's own 4-code pass-through list, but M8's seal-
  // time lane refusal (A9) has no existing code that fits without misleading the caller.
  'succession_lane_unsupported',
  // H8 (G1-10z attempt-4): the seal-time directory-cap refusal (chair-succession-execute.ts) and
  // the takeover's own cap refusal both throw this code — before this it mapped to the generic
  // `runtime_error`, losing the caller's ability to tell "directory full" from any other fault.
  'succession_directory_full',
  // Not in the wave 2 contract's own refusal list, but the same checkpoint_* family (D-R212
  // "sha changed after hashing → checkpoint_changed") — flagged in RETURN as a judgment call.
  'checkpoint_changed',
  'checkpoint_schema',
  'checkpoint_sections',
  'checkpoint_empty_section',
  'checkpoint_fence_line',
  'checkpoint_tag_line',
  'checkpoint_too_large',
  'checkpoint_secret_shape',
  'checkpoint_unsupported_claim',
  // N3: validateEmbeddedCharterText's refusal at seal time (data.line/data.code).
  'charter_invalid'
])

export function mapRuntimeError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    COMPUTER_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    const code = (error as { code: string }).code
    return errorResponse(id, meta, code, message, computerErrorData(code, message))
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('LINEAGE_')
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    LINEAR_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    STRUCTURED_RUNTIME_PASSTHROUGH_CODES.has((error as { code: string }).code)
  ) {
    return errorResponse(
      id,
      meta,
      (error as { code: string }).code,
      message,
      (error as { data?: unknown }).data
    )
  }
  if (RUNTIME_PASSTHROUGH_CODES.has(message)) {
    return errorResponse(id, meta, message, message)
  }
  if (message === 'invalid_terminal_send') {
    return errorResponse(id, meta, 'invalid_argument', 'Missing terminal send payload')
  }
  return errorResponse(id, meta, 'runtime_error', message)
}

export const computerErrorData = computerUseErrorRecoveryData

// Why: browser errors carry a structured .code property (BrowserError from
// cdp-bridge.ts) that maps directly to agent-facing error codes. We forward
// that code rather than falling back to the runtime allowlist, because the
// browser surface area uses its own code namespace (browser_no_tab, etc.).
export function mapBrowserError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return errorResponse(id, meta, (error as { code: string }).code, error.message)
  }
  return mapRuntimeError(id, meta, error)
}

// Why: same as browser — emulator errors (EmulatorError) carry .code (emulator_no_active etc.)
// so we forward the structured code instead of generic runtime_error.
export function mapEmulatorError(id: string, meta: RpcEnvelopeMeta, error: unknown): RpcFailure {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return errorResponse(id, meta, (error as { code: string }).code, error.message)
  }
  return mapRuntimeError(id, meta, error)
}
