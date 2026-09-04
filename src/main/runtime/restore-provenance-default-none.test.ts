/**
 * S10-21a C2 — T8/T8b (design v3.2 §6.1). Neither the sweep (C7) nor the pane-key gate (C3a)
 * exists yet, so every spawner in this slice must hand createTerminal `restoreProvenance:
 * {kind:'none'}` — this pins that at the two RPC-reachable entry points into
 * `ensureAgentSession`, and that the wire schema has no channel to say otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'

// T8b (compile-time half): the wire request type — what EnsureAgentSessionParams'
// z.discriminatedUnion infers to (agent-session.ts) — carries no provenance field on either
// branch. If a future change added one, `NoWireProvenance<...>` would resolve to `false` and
// the `const: true` assignments below would fail to compile.
type NoWireProvenance<T> = T extends { restoreProvenance: unknown } ? false : true
type CheckAutomaticBranch = NoWireProvenance<
  Extract<RuntimeEnsureAgentSessionRequest, { kind: 'automatic' }>
>
type CheckExplicitBranch = NoWireProvenance<
  Extract<RuntimeEnsureAgentSessionRequest, { kind: 'explicit' }>
>
const _assertAutomaticBranchCarriesNoProvenance: CheckAutomaticBranch = true
const _assertExplicitBranchCarriesNoProvenance: CheckExplicitBranch = true
void _assertAutomaticBranchCarriesNoProvenance
void _assertExplicitBranchCarriesNoProvenance

const PAIRED_DEVICE = 'paired-device-1'

function resumeRequest(sessionId: string) {
  return {
    kind: 'explicit' as const,
    worktree: 'id:worktree-1',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: sessionId }
  }
}

function terminal() {
  return {
    handle: 'term_restore_provenance',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-restore-provenance',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime() {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    {
      getLocalProvider: () =>
        ({
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true
        }) as never
    }
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  runtime.setPrincipalLaneLookup({
    principalOf: (deviceId) => (deviceId === PAIRED_DEVICE ? 'principal-1' : null),
    linkPrincipalOf: () => null
  })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
  return { runtime, createTerminal }
}

describe('restoreProvenance defaults to none (S10-21a C2, T8/T8b)', () => {
  it('T8 — a paired WS caller (pairedDeviceId set) resolves {kind: "none"}', async () => {
    const { runtime, createTerminal } = createRuntime()

    await expect(
      runtime.ensureAgentSession(resumeRequest('provider-session-paired'), {
        pairedDeviceId: PAIRED_DEVICE
      })
    ).resolves.toMatchObject({ disposition: 'created' })

    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createTerminal.mock.calls[0]?.[1]?.restoreProvenance).toEqual({ kind: 'none' })
  })

  it('T8b — a local-socket caller (no pairedDeviceId) with a foreign session id resolves {kind: "none"}', async () => {
    const { runtime, createTerminal } = createRuntime()

    // "Foreign" here: a session id this caller has no lane/ownership relationship to — the local
    // unix socket is 0600 with no pairedDeviceId (INV-P-021), so the caller context below is
    // exactly what any same-uid process presents.
    await expect(
      runtime.ensureAgentSession(resumeRequest('foreign-provider-session'), {})
    ).resolves.toMatchObject({ disposition: 'created' })

    expect(createTerminal).toHaveBeenCalledOnce()
    expect(createTerminal.mock.calls[0]?.[1]?.restoreProvenance).toEqual({ kind: 'none' })
  })
})
