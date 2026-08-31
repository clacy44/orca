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

  // S10-6 (R3 + R5 reproduction, adjusted scope): the field scenario from the chair's ruling —
  // hook server "generation 2" (a fresh AgentHookServer instance), a live pty restored WITHOUT a
  // launchTokenHash (terminal.launchTokenHash null) and WITHOUT a restored receipt
  // (restoredOrchestrationAuthorityByPtyId has no entry for PTY_ID), the agent process presenting
  // a "generation 1" (pre-restart) token via /reattest, the endpoint file being this generation's
  // (postReattest always uses server.buildPtyEnv()'s current token, matching R1's header
  // behavior) — reproduced faithfully, with ONE adjustment from the ruling's literal wording:
  // the pane DOES carry a genuinely disk-hydrated commitment (seeded exactly like the "actual
  // fix" test above, i.e. as a real prior session would have persisted it), rather than none at
  // all. See the DEVIATION comment on handleReattestRequest in server.ts for why "no hydrated
  // commitment for the pane" specifically cannot be the passing case: traced against the very
  // next test below (kept from S10-5, still passing), making it pass would mean a caller with no
  // receipt and no genuine history for a paneKey can manufacture its own attestation by choosing
  // its own /reattest launchToken and later claiming the identical value — which is exactly what
  // that test exists to refuse.
  describe('S10-6 (R3): live recheck when the exact-surface-restore moment never minted a receipt', () => {
    function seedHydratedCommitment(hookServer: AgentHookServer, launchToken: string): void {
      const hydratedEntry = {
        paneKey: PANE_KEY,
        launchToken,
        tabId: 'tab-restored',
        worktreeId: WORKTREE_ID,
        connectionId: null,
        payload: { state: 'working', prompt: 'before restart', agentType: 'codex' },
        receivedAt: 100,
        stateStartedAt: 100
      } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
      hookServer._getStateForTests().lastStatusByPaneKey.set(PANE_KEY, hydratedEntry)
    }

    it('succeeds: reattest recovers a genuinely hydrated pane from a stale blocking observation, with no receipt', async () => {
      server = new AgentHookServer()
      const generation1Token = 'agent-process-env-generation-1-token'
      seedHydratedCommitment(server, generation1Token)
      await server.start({ env: 'production' })
      const env = server.buildPtyEnv() // "generation 2" coordinates — fresh port + token
      const runtime = wireRuntime(server)
      // Why: WITHOUT a launchTokenHash (daemon-survived) AND WITHOUT a restored receipt — the
      // exact scenario named in the ruling. wireRuntime's mock terminal already has
      // launchTokenHash: null; restoredOrchestrationAuthorityByPtyId is left empty here.

      // Why this extra step: with zero currentAuthorityObservations, a hydrated commitment alone
      // already attests via the 'hydrated_commitment' fast path (see
      // orchestration-compatibility-authority.test.ts's "mints a receipt..." case) — that would
      // make this test pass without reattest doing any work, which isn't the field failure R5
      // describes. A stale observation for the SAME pane (e.g. an earlier, unrelated event in
      // this generation) blocks that fast path exactly as it did in the "actual fix" test above —
      // this is what makes the pre-restart, no-receipt caller genuinely dependent on reattest.
      await postReattest(Number(env.ORCA_AGENT_HOOK_PORT), env.ORCA_AGENT_HOOK_TOKEN!, {
        paneKey: PANE_KEY,
        terminalHandle: TERMINAL_HANDLE,
        launchToken: 'a-different-stale-token'
      })
      expect(
        runtime.verifyOrchestrationCompatibilityCaller({
          terminalHandle: TERMINAL_HANDLE,
          paneKey: PANE_KEY,
          launchToken: generation1Token
        })
      ).toBeNull() // blocked by the stale observation seeded just above.

      // The actual R5 shape: reattest with the stale-but-genuine generation-1 token, against this
      // generation's fresh (generation-2) hook token — mirrors what attemptOrchestrationReattest
      // posts today (X-Orca-Agent-Hook-Token: this generation's file token; body.launchToken: the
      // caller's own env-sourced value, unaffected by generation).
      const reattestRes = await postReattest(
        Number(env.ORCA_AGENT_HOOK_PORT),
        env.ORCA_AGENT_HOOK_TOKEN!,
        { paneKey: PANE_KEY, terminalHandle: TERMINAL_HANDLE, launchToken: generation1Token }
      )
      expect(reattestRes.status).toBe(204)

      const authority = runtime.verifyOrchestrationCompatibilityCaller({
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: generation1Token
      })
      expect(authority).toMatchObject({ paneKey: PANE_KEY, terminalHandle: TERMINAL_HANDLE })
      // Why (R3): the receipt is minted as a side effect of this success, even though
      // wireRuntime's runtime has no live ptysById entry for PTY_ID to mint against — covered
      // with a real ptysById entry in orchestration-compatibility-authority.test.ts.
    })

    it('negative control: the exact same shape with NO hydrated commitment still refuses (residual gap, unchanged)', async () => {
      server = new AgentHookServer()
      // Why: deliberately skip seedHydratedCommitment — this is the literal "no hydrated
      // commitment for the pane" case from the ruling's R5 wording, which the DEVIATION comment
      // on handleReattestRequest explains is not safe to close with a caller-suppliable secret.
      await server.start({ env: 'production' })
      const env = server.buildPtyEnv()
      const runtime = wireRuntime(server)
      const generation1Token = 'agent-process-env-generation-1-token'

      const reattestRes = await postReattest(
        Number(env.ORCA_AGENT_HOOK_PORT),
        env.ORCA_AGENT_HOOK_TOKEN!,
        { paneKey: PANE_KEY, terminalHandle: TERMINAL_HANDLE, launchToken: generation1Token }
      )
      // Why: handleReattestRequest itself has no opinion on hydration — 204 either way (see
      // the SECURITY EQUIVALENCE / R4 comments on why this status can't distinguish the cases).
      expect(reattestRes.status).toBe(204)

      expect(
        runtime.verifyOrchestrationCompatibilityCaller({
          terminalHandle: TERMINAL_HANDLE,
          paneKey: PANE_KEY,
          launchToken: generation1Token
        })
      ).toBeNull()
    })
  })
})
