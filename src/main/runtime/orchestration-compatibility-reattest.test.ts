// S10-5: end-to-end proof that POST /reattest is security-equivalent to a real hook POST — it
// can seed a currentAuthorityObservation, but every other conjunct in
// verifyOrchestrationCompatibilityCaller (live pty, restored-receipt match, paneKey equality on
// the final attestation, and — for 'restored' provenance — a genuinely disk-hydrated commitment,
// which AgentHookServer keeps immutable for the runtime's life, see
// server-authority-evidence.test.ts's `toBe(commitments)` assertion) stays fully load-bearing.
//
// A forged {paneKey, launchToken} for a pane with no matching restored receipt must still
// refuse, no matter what reattest wrote. And reattest must not be a no-op: it has to be able to
// reconcile a currentAuthorityObservations entry that is blocking attestation (e.g. left over
// from an earlier event for the same pane) into the caller's freshly-claimed, correct evidence —
// that reconciliation is what makes the retried CLI call succeed in practice.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-restored', LEAF)
const TERMINAL_HANDLE = 'term-restored-1'
const PTY_ID = 'pty-restored-1'
const WORKTREE_ID = 'repo-1::/worktree'
const PROCESS_INCARNATION = 'pty-restored-1:incarnation-1'
const HOST_SCOPE = { kind: 'local' as const, hostId: 'local' as const }

type TerminalAuthorityResolver = {
  getOrchestrationDispatchAuthority: (terminalHandle: string) => unknown
  restoredOrchestrationAuthorityByPtyId: Map<string, Record<string, unknown>>
}

function wireRuntime(server: AgentHookServer): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null, undefined, {
    attestAgentHookCompatibilityAuthority: (candidate) =>
      server.attestCompatibilityAuthority(candidate)
  })
  ;(runtime as unknown as TerminalAuthorityResolver).getOrchestrationDispatchAuthority = () => ({
    runtimeId: 'runtime-1',
    terminalHandle: TERMINAL_HANDLE,
    ptyId: PTY_ID,
    worktreeId: WORKTREE_ID,
    processIncarnation: PROCESS_INCARNATION,
    paneKey: PANE_KEY,
    // Why: null models a daemon-survived pane post-restart — no fresh runtime-minted token to
    // hard-compare against, which is exactly the branch that falls through to receipt + attestation.
    launchTokenHash: null,
    hostScope: HOST_SCOPE
  })
  return runtime
}

function postReattest(port: number, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/reattest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
    body: JSON.stringify(body)
  })
}

describe('/reattest end-to-end against verifyOrchestrationCompatibilityCaller', () => {
  let server: AgentHookServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  it('refuses a forged pane with no matching restored receipt, even after a successful reattest', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const runtime = wireRuntime(server)
    // Why: deliberately leave restoredOrchestrationAuthorityByPtyId EMPTY — this is the "no
    // matching restored receipt" case the chair's ruling names explicitly.
    const forgedToken = 'attacker-supplied-token'

    const reattestRes = await postReattest(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN!,
      {
        paneKey: PANE_KEY,
        terminalHandle: TERMINAL_HANDLE,
        launchToken: forgedToken
      }
    )
    // Why: reattest itself has no opinion on receipts — it only records an observation, matching
    // what a real hook POST with the same body would do. The refusal must come from the runtime.
    expect(reattestRes.status).toBe(204)
    expect(server.getCurrentAuthorityObservations()).toHaveLength(1)

    const authority = runtime.verifyOrchestrationCompatibilityCaller({
      terminalHandle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      launchToken: forgedToken
    })

    expect(authority).toBeNull()
  })

  it('reconciles a blocking stale observation into the pane, once a matching receipt exists (the actual fix)', async () => {
    server = new AgentHookServer()
    const originalLaunchToken = 'this-pane-original-launch-token'
    // Why: a genuinely disk-hydrated commitment for this pane, exactly as a prior session would
    // have persisted it (server-authority-evidence.test.ts models the same seeding). Without this,
    // 'restored' provenance can never attest — by design, not something reattest may override.
    const hydratedEntry = {
      paneKey: PANE_KEY,
      launchToken: originalLaunchToken,
      tabId: 'tab-restored',
      worktreeId: WORKTREE_ID,
      connectionId: null,
      payload: { state: 'working', prompt: 'before restart', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    server._getStateForTests().lastStatusByPaneKey.set(PANE_KEY, hydratedEntry)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const runtime = wireRuntime(server)
    ;(runtime as unknown as TerminalAuthorityResolver).restoredOrchestrationAuthorityByPtyId.set(
      PTY_ID,
      {
        ptyId: PTY_ID,
        worktreeId: WORKTREE_ID,
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        processIncarnation: PROCESS_INCARNATION,
        hostScope: HOST_SCOPE
      }
    )
    // Why: a stale/wrong observation already occupies this pane's single-slot Map entry (e.g. an
    // earlier reattest attempt that raced with a not-yet-refreshed env, or any other stale event)
    // — this is what blocks the hydrated-commitment fast path, and reconciling it via an
    // overwrite (not addition) is exactly what a correct reattest must do.
    await postReattest(Number(env.ORCA_AGENT_HOOK_PORT), env.ORCA_AGENT_HOOK_TOKEN!, {
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      launchToken: 'a-different-stale-token'
    })
    expect(
      runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: originalLaunchToken
      })
    ).toBeNull()

    const reattestRes = await postReattest(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN!,
      {
        paneKey: PANE_KEY,
        terminalHandle: TERMINAL_HANDLE,
        launchToken: originalLaunchToken
      }
    )
    expect(reattestRes.status).toBe(204)

    const authority = runtime.verifyOrchestrationCompatibilityCaller({
      terminalHandle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      launchToken: originalLaunchToken
    })
    expect(authority).toMatchObject({
      paneKey: PANE_KEY,
      terminalHandle: TERMINAL_HANDLE,
      processIncarnation: PROCESS_INCARNATION,
      launchTokenHash: createHash('sha256').update(originalLaunchToken).digest('hex')
    })
  })
})
