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

// S10-6 (R4): 'no-endpoint-file' and 'stale-endpoint-token' are the two reasons
// attemptOrchestrationReattest can determine for itself below — one without a round trip, one
// from an unambiguous 403 (the header token it has is not this generation's, regardless of
// whose pane it's for). 'pane-not-admitted' is NOT produced here: handleReattestRequest returns
// the identical 204 for a genuine success and for a disposition-not-'accept' refusal
// (deliberately — a distinguishable status would let a caller enumerate which paneKeys are
// currently open), so only client.ts — after seeing the retried RPC still fail post-"success" —
// can infer it; it's included in this shared type so client.ts's substitution uses the same
// three labels and message-builder as this module. A 404 (older runtime, no /reattest route)
// and other outcomes (429 rate-limited, network/timeout, malformed shape) intentionally produce
// no reason: client.ts leaves the server's original nextSteps untouched for those, same as
// pre-S10-6 behavior, since "re-run the command" is still reasonably accurate advice for them.
export type OrchestrationReattestFailureReason =
  | 'no-endpoint-file'
  | 'stale-endpoint-token'
  | 'pane-not-admitted'

export type OrchestrationReattestOutcome =
  | { ok: true }
  | { ok: false; reason?: Exclude<OrchestrationReattestFailureReason, 'pane-not-admitted'> }

/** S10-6 (R4): swap in the accurate first nextStep — the server's canned
 *  `NO_PANE_IDENTITY_NEXT_STEPS[0]` ("re-run the command — the CLI re-attests this pane
 *  automatically...") is actively misleading once we already know reattest ran and didn't
 *  help. Only index 0 is replaced; the remaining nextSteps (register/relaunch guidance) are
 *  left as the server sent them. Returns `response` unchanged if it carries no
 *  `{ nextSteps: string[] }` data shape to patch (defensive — every no_pane_identity refusal
 *  sets one today via orchestration-caller-identity.ts). */
export function withReattestFailureNextStep(
  response: RuntimeRpcFailure,
  reason: OrchestrationReattestFailureReason
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
  return {
    ...response,
    error: {
      ...response.error,
      data: {
        ...data,
        nextSteps: [
          `this pane cannot re-attest (reason: ${reason}); relaunch this agent in a fresh Orca pane (claude --resume keeps its context)`,
          ...nextSteps.slice(1)
        ]
      }
    }
  }
}

/** Best-effort — never throws. `ok: true` only when the runtime accepted the reattest.
 *
 *  S10-6 (R1): no longer requires paneKey/terminalHandle/launchToken to all already be
 *  present in the caller's own env-sourced evidence — paneKey/terminalHandle prefer the
 *  endpoint file's values when it carries them (today it never does; see
 *  agent-hook-endpoint-file.ts), falling back to evidence otherwise, same as before.
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
  if (!endpointPath || !evidence?.launchToken) {
    return { ok: false, reason: 'no-endpoint-file' }
  }
  const coordinates = readHookEndpointCoordinates(endpointPath)
  if (!coordinates) {
    return { ok: false, reason: 'no-endpoint-file' }
  }
  const paneKey = coordinates.paneKey ?? evidence.paneKey
  const terminalHandle = coordinates.terminalHandle ?? evidence.terminalHandle
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
