// S10-5: when an attested orchestration verb refuses no_pane_identity, a daemon-survived pane's
// process env can still hold pre-restart-but-otherwise-correct identity (paneKey, terminalHandle,
// launchToken) — the runtime just doesn't have a matching in-process observation for it yet. This
// re-attests by POSTing that same env-sourced evidence to the runtime's local hook endpoint (the
// same loopback, token-gated channel every real agent hook event already uses) and lets the
// caller retry once. See src/main/agent-hooks/server.ts's handleReattestRequest for the
// server-side security-equivalence argument.
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  isAgentHookEndpointFileName,
  parseAgentHookEndpointFile
} from '../../shared/agent-hook-endpoint-file'
import { AGENT_HOOK_REATTEST_PATHNAME } from '../../shared/agent-hook-listener'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'

// Why: the file is a handful of `KEY=VALUE` lines; bound reads generously above that so a
// tampered/enormous file can't be read wholesale, without needing to guess an exact byte count.
const MAX_ENDPOINT_FILE_BYTES = 4_096
const REATTEST_TIMEOUT_MS = 2_000

type HookEndpointCoordinates = {
  port: string
  token: string
  paneKey?: string
  terminalHandle?: string
}

function readHookEndpointCoordinates(endpointPath: string): HookEndpointCoordinates | null {
  if (!isAgentHookEndpointFileName(basename(endpointPath))) {
    return null
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(endpointPath)
  } catch {
    return null
  }
  // Why: cheap symlink check — the runtime writes this file directly (writeEndpointFile renames a
  // tmp file into place, no symlink involved); a symlink here is unexpected and not worth
  // resolving/following.
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return null
  }
  if (statSync(endpointPath).size > MAX_ENDPOINT_FILE_BYTES) {
    return null
  }
  let raw: string
  try {
    raw = readFileSync(endpointPath, 'utf8')
  } catch {
    return null
  }
  try {
    const fields = parseAgentHookEndpointFile(raw)
    return {
      port: fields.port,
      token: fields.token,
      ...(fields.paneKey ? { paneKey: fields.paneKey } : {}),
      ...(fields.terminalHandle ? { terminalHandle: fields.terminalHandle } : {})
    }
  } catch {
    return null
  }
}

// S10-6 (R4): 'no-endpoint-file', 'no-launch-token' and 'stale-endpoint-token' are the reasons
// attemptOrchestrationReattest can determine for itself below — two without a round trip, one
// from an unambiguous 403 (the header token it has is not this generation's, regardless of
// whose pane it's for). 'still-unattested-after-reattest' is NOT produced here:
// handleReattestRequest returns the identical 204 for a genuine success and for a
// disposition-not-'accept' refusal (deliberately — a distinguishable status would let a caller
// enumerate which paneKeys are currently open), so only client.ts — after seeing the retried
// RPC still fail post-"success" — can infer that reattest didn't help; it's included in this
// shared type so client.ts's substitution uses the same message-builder as this module.
//
// S10-6 review correction: that post-204 case was originally labeled 'pane-not-admitted' and
// asserted as fact in the nextStep sentence. It has at least four causes — disposition wasn't
// 'accept' (genuinely not admitted) is only one; the others (no hydrated commitment for the
// pane, a live-recheck conjunct failing, attestation ambiguity) all mean the pane IS admitted.
// This client-inferred case can only ever tell that reattest didn't help, never why — so its
// name and message are cause-neutral now; only 'no-endpoint-file'/'no-launch-token'/
// 'stale-endpoint-token' assert a specific cause, because those really are determined
// unambiguously above.
//
// F-6a (H2, Ruling 32a): 'no-launch-token' split out of what used to be a single
// 'no-endpoint-file' reason (see attemptOrchestrationReattest below) — a pane with a current,
// readable endpoint file but no ORCA_AGENT_LAUNCH_TOKEN in its own env was never launched as
// an Orca agent pane and, per Ruling 12 (E1), never will attest: re-attesting cannot fix it.
//
// A 404 (older runtime, no /reattest route) and other outcomes (429 rate-limited,
// network/timeout, malformed shape) intentionally produce no reason: client.ts leaves the
// server's original nextSteps untouched for those, same as pre-S10-6 behavior, since "re-run
// the command" is still reasonably accurate advice for them.
export type OrchestrationReattestFailureReason =
  | 'no-endpoint-file'
  | 'no-launch-token'
  | 'stale-endpoint-token'
  | 'still-unattested-after-reattest'

export type OrchestrationReattestOutcome =
  | { ok: true }
  | {
      ok: false
      reason?: Exclude<OrchestrationReattestFailureReason, 'still-unattested-after-reattest'>
    }

// F-6a/F-6d (H2, Ruling 32a): both a pane that never had a token ('no-launch-token') and a pane
// whose token was minted but never recorded by the runtime (the cause-neutral case below, which
// covers that corner among others) share the same remedy and the same unrecoverable-in-place
// fact — say both plainly, and name an Orca AGENT pane specifically: `orca terminal create`
// mints no token and reproduces the identical failure.
const AGENT_PANE_UNRECOVERABLE_NEXT_STEP =
  "this pane was not launched as an Orca agent pane (no launch token), so re-attesting cannot fix it and the state is not recoverable in place; close this pane's tab and open a new Orca AGENT pane (the app launcher, or `orca worktree create --agent claude`) — never `orca terminal create`, which mints no token — then `claude --resume <session>` there"

const CAUSE_NEUTRAL_NEXT_STEP =
  "re-attestation was accepted but this pane still has no attested identity; if re-running does not clear it, this pane cannot be repaired in place — close this pane's tab and open a new Orca AGENT pane (the app launcher, or `orca worktree create --agent claude`) — never `orca terminal create`, which mints no token — then `claude --resume <session>` there"

// Item 3(b) / F-6a/F-6d follow-up (Ruling 32 Addendum 3(c)): the cause-neutral message above
// covers a `still-unattested-after-reattest` disposition in general (see the Why block above:
// three of its four causes clear on retry), but when the caller's OWN evidence already carries
// a launch token, the runtime accepted re-attestation, and identity is still absent, the only
// cause left reachable is that the runtime never recorded an anchor for that token — name it.
const TOKEN_PRESENT_NO_ANCHOR_NEXT_STEP =
  "this pane holds a launch token but the runtime has no anchor for it; close this pane's tab and open a new Orca AGENT pane (the app launcher, or `orca worktree create --agent claude`) — never `orca terminal create`, which mints no token — then `claude --resume <session>` there"

/** S10-6 (R4): swap in the accurate first nextStep — the server's canned
 *  `NO_PANE_IDENTITY_NEXT_STEPS[0]` ("re-run the command — the CLI re-attests this pane
 *  automatically...") is actively misleading once we already know reattest ran and didn't
 *  help. Only index 0 is replaced; the remaining nextSteps (register/relaunch guidance) are
 *  left as the server sent them. Returns `response` unchanged if it carries no
 *  `{ nextSteps: string[] }` data shape to patch (defensive — every no_pane_identity refusal
 *  sets one today via orchestration-caller-identity.ts). */
export function withReattestFailureNextStep(
  response: RuntimeRpcFailure,
  reason: OrchestrationReattestFailureReason,
  evidence?: OrchestrationCompatibilityEvidence
): RuntimeRpcFailure {
  const data = response.error.data
  if (
    typeof data !== 'object' ||
    data === null ||
    !('nextSteps' in data) ||
    !Array.isArray((data as { nextSteps: unknown }).nextSteps)
  ) {
    return response
  }
  const nextSteps = (data as { nextSteps: unknown[] }).nextSteps
  // Why: only 'no-endpoint-file'/'no-launch-token'/'stale-endpoint-token' are a specific,
  // client-determined cause — state them. 'still-unattested-after-reattest' is inferred, not
  // determined (see the Why above the type), so its sentence never claims a specific cause —
  // but 'no-launch-token' and the cause-neutral case share the same AGENT-pane remedy text.
  const nextStep =
    reason === 'still-unattested-after-reattest'
      ? evidence?.launchToken
        ? TOKEN_PRESENT_NO_ANCHOR_NEXT_STEP
        : CAUSE_NEUTRAL_NEXT_STEP
      : reason === 'no-launch-token'
        ? AGENT_PANE_UNRECOVERABLE_NEXT_STEP
        : `this pane cannot re-attest (reason: ${reason}); relaunch this agent in a fresh Orca pane (claude --resume keeps its context)`
  return {
    ...response,
    error: {
      ...response.error,
      data: {
        ...data,
        nextSteps: [nextStep, ...nextSteps.slice(1)]
      }
    }
  }
}

/** Best-effort — never throws. `ok: true` only when the runtime accepted the reattest.
 *
 *  S10-6 (R1): no longer requires paneKey/terminalHandle/launchToken to all already be
 *  present in the caller's own env-sourced evidence — paneKey/terminalHandle now fall back to
 *  the endpoint file's values ONLY when the caller's own evidence lacks them; evidence always
 *  wins when present. (S10-6 review correction: an earlier version of this code preferred the
 *  endpoint file's values over evidence. The endpoint file is one shared, runtime-wide secret —
 *  identical for every pane's spawn env, see the launchToken DEVIATION paragraph below — so a
 *  paneKey/terminalHandle recorded in it can only ever name ONE pane; file-first precedence
 *  would let every other pane's reattest resolve to that same pane's identity the moment a
 *  future writer starts populating those optional fields, which agent-hook-endpoint-file.ts
 *  explicitly invites. Evidence-first keeps each pane resolving its own identity from its own
 *  process env, same as pre-R1, and only reaches for the file when a pane's own env is missing
 *  a field — today the file never carries these fields either, so this fallback is dormant.)
 *
 *  DEVIATION from the literal chair ruling: launchToken is NOT sourced from the endpoint
 *  file's token. That file is one shared, runtime-wide secret (single `endpoint.env` per
 *  Orca instance, `this.token` in AgentHookServer, injected into every pane's spawn env
 *  identically — see server.ts buildPtyEnv/AGENT_HOOK_ENDPOINT) gating the loopback HTTP
 *  listener itself, not a per-pane credential; ORCA_AGENT_LAUNCH_TOKEN is the actual
 *  per-pane secret (a fresh randomUUID minted per pty launch, orca-runtime.ts:27018-27019,
 *  living only in that pane's own process env). Using the shared file token as "the launch
 *  credential" would make every pane's reattest launchToken identical and caller-known,
 *  which — once the server seeds a hydrated authority commitment from whatever /reattest
 *  presents (R2) — would let any pane assert authority for any other open pane's paneKey
 *  merely by knowing its live terminalHandle. Keeping launchToken env-sourced preserves the
 *  existing per-pane-secret property; a caller with no env launchToken still can't reattest
 *  (nothing here regresses — that caller could not have reattested before this change either).
 */
export async function attemptOrchestrationReattest(
  evidence: OrchestrationCompatibilityEvidence | undefined
): Promise<OrchestrationReattestOutcome> {
  const endpointPath = process.env.ORCA_AGENT_HOOK_ENDPOINT
  if (!endpointPath) {
    return { ok: false, reason: 'no-endpoint-file' }
  }
  // F-6a (H2, Ruling 32a): the endpoint file and the launch token are two unrelated
  // preconditions that used to share one reason string — a pane with a current, readable
  // endpoint file but genuinely no launch token (never launched as an Orca agent pane, and
  // never will be — Ruling 12 E1) was misdiagnosed as "no endpoint file", which is false.
  if (!evidence?.launchToken) {
    return { ok: false, reason: 'no-launch-token' }
  }
  const coordinates = readHookEndpointCoordinates(endpointPath)
  if (!coordinates) {
    return { ok: false, reason: 'no-endpoint-file' }
  }
  // Why (S10-6 review correction): evidence (the pane's own process env) must win over the
  // endpoint file — see the DEVIATION paragraph above. The file is only a fallback for a field
  // evidence doesn't carry.
  const paneKey = evidence.paneKey ?? coordinates.paneKey
  const terminalHandle = evidence.terminalHandle ?? coordinates.terminalHandle
  if (!paneKey || !terminalHandle) {
    return { ok: false, reason: 'no-endpoint-file' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REATTEST_TIMEOUT_MS)
  try {
    const response = await fetch(
      `http://127.0.0.1:${coordinates.port}${AGENT_HOOK_REATTEST_PATHNAME}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': coordinates.token
        },
        body: JSON.stringify({
          paneKey,
          terminalHandle,
          launchToken: evidence.launchToken
        }),
        signal: controller.signal
      }
    )
    if (response.status === 204) {
      return { ok: true }
    }
    if (response.status === 403) {
      return { ok: false, reason: 'stale-endpoint-token' }
    }
    // Why: a 404 means an older runtime with no /reattest route — the caller keeps its original
    // refusal and its nextSteps rather than treating this as a retryable condition. 429/400 are
    // left equally reason-less (see the type's Why above).
    return { ok: false }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}
