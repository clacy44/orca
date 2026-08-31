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

// Why: the file is a handful of `KEY=VALUE` lines; bound reads generously above that so a
// tampered/enormous file can't be read wholesale, without needing to guess an exact byte count.
const MAX_ENDPOINT_FILE_BYTES = 4_096
const REATTEST_TIMEOUT_MS = 2_000

function readHookEndpointCoordinates(endpointPath: string): { port: string; token: string } | null {
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
    return { port: fields.port, token: fields.token }
  } catch {
    return null
  }
}

/** Best-effort — never throws. Returns true only when the runtime accepted the reattest. */
export async function attemptOrchestrationReattest(
  evidence: OrchestrationCompatibilityEvidence | undefined
): Promise<boolean> {
  const endpointPath = process.env.ORCA_AGENT_HOOK_ENDPOINT
  if (!endpointPath || !evidence?.paneKey || !evidence.terminalHandle || !evidence.launchToken) {
    return false
  }
  const coordinates = readHookEndpointCoordinates(endpointPath)
  if (!coordinates) {
    return false
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
          paneKey: evidence.paneKey,
          terminalHandle: evidence.terminalHandle,
          launchToken: evidence.launchToken
        }),
        signal: controller.signal
      }
    )
    // Why: a 404 means an older runtime with no /reattest route — the caller keeps its original
    // refusal and its nextSteps rather than treating this as a retryable condition.
    return response.status === 204
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
