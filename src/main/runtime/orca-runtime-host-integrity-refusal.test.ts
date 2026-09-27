// INV-P-023: createAgentSession/ensureAgentSession fail-fast before any of their side effects.
// Harness lifted from orca-runtime-launch-admission-request-boundary.test.ts:52-80.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { HostElevatedRefusedError } from '../ipc/agent-launch-admission-errors'
import { mapRuntimeError } from './rpc/errors'
import {
  configureHostIntegrityForTests,
  resetHostIntegrityForTests
} from '../host-integrity/host-integrity-guard'
import type { IntegrityProbe } from '../host-integrity/windows-integrity-level'

function probeOf(level: IntegrityProbe['level']): () => Promise<IntegrityProbe> {
  return async () => ({ level, detail: 'test' })
}

function operationId(suffix: string): string {
  return `${Date.now()}-${suffix.padEnd(32, '0')}`
}

function createRequest(clientOperationId: string): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'claude',
    prompt: 'do the thing',
    presentation: 'background'
  }
}

function resumeRequest() {
  return {
    kind: 'explicit' as const,
    worktree: 'id:worktree-1',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'provider-session-1' }
  }
}

function terminal() {
  return {
    handle: 'term_host_integrity',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-host-integrity',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime() {
  const db = new OrchestrationDb(':memory:')
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
  runtime.setOrchestrationDb(db)
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
  return { runtime, createTerminal, internal, db }
}

function hostIntegrityRows(db: OrchestrationDb) {
  return (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
    .prepare("SELECT outcome, reason_code FROM agent_audit WHERE verb = 'host_integrity'")
    .all() as { outcome: string; reason_code: string }[]
}

describe('INV-P-023: createAgentSession/ensureAgentSession fail-fast', () => {
  beforeEach(() => resetHostIntegrityForTests())
  afterEach(() => resetHostIntegrityForTests())

  it('high: createAgentSession rejects before its side effects, one refused row', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const { runtime, createTerminal, internal, db } = createRuntime()

    const error = await runtime
      .createAgentSession(createRequest(operationId('b001')))
      .catch((thrown: unknown) => thrown)

    expect((error as { code?: string }).code).toBe('host_elevated_refused')
    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.resolveTerminalWorkspaceLaunchScope).not.toHaveBeenCalled()
    expect(internal.markLocalWorkspaceTrustedForAgent).not.toHaveBeenCalled()
    const rows = hostIntegrityRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('refused')
    expect(rows[0].reason_code).toContain('via=create_agent_session')
    db.close()
  })

  it('high with ORCA_ALLOW_ELEVATED=1: resolves created, zero host_integrity rows', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high'), env: { ORCA_ALLOW_ELEVATED: '1' } })
    const { runtime, createTerminal, db } = createRuntime()

    await expect(
      runtime.createAgentSession(createRequest(operationId('b002')))
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(hostIntegrityRows(db)).toHaveLength(0)
    db.close()
  })

  it('high: explicit ensureAgentSession is refused the same way', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const { runtime, createTerminal, db } = createRuntime()

    const error = await runtime
      .ensureAgentSession(resumeRequest())
      .catch((thrown: unknown) => thrown)

    expect((error as { code?: string }).code).toBe('host_elevated_refused')
    expect(createTerminal).not.toHaveBeenCalled()
    const rows = hostIntegrityRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].reason_code).toContain('via=ensure_agent_session')
    db.close()
  })

  it('medium: created, unchanged', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium') })
    const { runtime, createTerminal, db } = createRuntime()

    await expect(
      runtime.createAgentSession(createRequest(operationId('b003')))
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledOnce()
    expect(hostIntegrityRows(db)).toHaveLength(0)
    db.close()
  })

  it('mapRuntimeError structured-passthroughs HostElevatedRefusedError', () => {
    const sentence = 'Orca is running elevated, so new agent sessions are refused.'
    const error = new HostElevatedRefusedError(sentence, {
      source: 'main',
      main: 'high',
      daemon: null
    })
    const result = mapRuntimeError('r1', { runtimeId: 'rt' }, error)
    expect(result.error).toEqual({
      code: 'host_elevated_refused',
      message: sentence,
      data: { source: 'main', main: 'high', daemon: null }
    })
  })
})
