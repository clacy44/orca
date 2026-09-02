// S10-19 W-3 (Ruling 24(a), RISK 1): the dispatch-preamble split between the peer and full
// access profiles. W3-T1..T4, S-9.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import type { RpcContext } from './rpc/core'

function findMethod(name: string) {
  const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

const TASK_SPEC = 'Refactor the dispatch mailbox resolver and add tests.'

describe('S10-19 W3-T1: peer profile never types taskSpec', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('the pane receives a preamble containing no substring of taskSpec; a dispatch: mail row carries it; notifyMessageArrived fires', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace',
      repoId: 'peer-repo'
    } as never)
    vi.spyOn(runtime, 'getFederationDispatchRepos').mockReturnValue(['peer-repo'])
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_peer_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_peer_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_peer_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const sendPrompt = vi
      .spyOn(runtime, 'sendTerminalAgentPrompt')
      .mockResolvedValue({ handle: 'term_peer_worker', accepted: true, bytesWritten: 1 })
    const notify = vi.spyOn(runtime, 'notifyMessageArrived')

    const method = findMethod('orchestration.federationAttachStart')
    const ctx: RpcContext = {
      runtime,
      accessProfile: 'peer',
      orchestrationMutation: {
        callerFingerprint: 'home_peer',
        requestId: 'request_peer_1',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'peer_payload_1'
      }
    }
    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_aaaaaaaaaaaa',
        taskId: 'task_aaaaaaaaaaaa',
        taskSpec: TASK_SPEC,
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'codex'
      }),
      ctx
    )) as { state: string }

    expect(result.state).toBe('ready')
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const [, promptText] = sendPrompt.mock.calls[0]!
    expect(promptText).not.toContain(TASK_SPEC)

    const raw = (db as unknown as { db: { prepare: (s: string) => { get: () => unknown } } }).db
      .prepare(`SELECT * FROM messages WHERE to_handle = 'dispatch:ctx_aaaaaaaaaaaa'`)
      .get() as { body: string; type: string; from_handle: string } | undefined
    expect(raw).toBeDefined()
    expect(raw?.body).toBe(TASK_SPEC)
    expect(raw?.type).toBe('dispatch')

    expect(notify).toHaveBeenCalledWith('dispatch:ctx_aaaaaaaaaaaa', 'dispatch')
  })
})

describe('S10-19 W3-T2: off-grammar dispatch/task ids refuse before any effect', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  it('an off-grammar taskId (embedded CRLF) refuses invalid_argument with no attachment row', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const method = findMethod('orchestration.federationAttachStart')
    const ctx: RpcContext = {
      runtime,
      accessProfile: 'peer',
      orchestrationMutation: {
        callerFingerprint: 'home_peer',
        requestId: 'request_bad_id',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'bad_payload'
      }
    }
    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_bbbbbbbbbbbb',
          taskId: 'evil\r\ninjected',
          taskSpec: TASK_SPEC,
          protocolVersion: 3,
          worktree: 'new-top-level',
          repo: 'some-repo',
          name: 'worker'
        }),
        ctx
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getRemoteDispatchAttachment('ctx_bbbbbbbbbbbb')).toBeUndefined()
  })

  it('an off-grammar dispatchId refuses invalid_argument, no attachment row', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const method = findMethod('orchestration.federationAttachStart')
    const ctx: RpcContext = {
      runtime,
      accessProfile: 'peer',
      orchestrationMutation: {
        callerFingerprint: 'home_peer',
        requestId: 'request_bad_dispatch',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'bad_payload_2'
      }
    }
    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'not-a-real-id',
          taskId: 'task_cccccccccccc',
          taskSpec: TASK_SPEC,
          protocolVersion: 3,
          worktree: 'new-top-level',
          repo: 'some-repo',
          name: 'worker'
        }),
        ctx
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getRemoteDispatchAttachment('not-a-real-id')).toBeUndefined()
  })

  it('a FULL-profile caller (accessProfile undefined) is never subject to the id-grammar check', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockRejectedValue(new Error('nope'))
    const method = findMethod('orchestration.federationAttachStart')
    const ctx: RpcContext = {
      runtime,
      orchestrationMutation: {
        callerFingerprint: 'home_full',
        requestId: 'request_full_freeform',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'full_payload'
      }
    }
    // A freeform (non-host-grammar) dispatchId from a FULL caller reaches worktree resolution
    // (and fails there, for an unrelated reason — the mocked rejection above) rather than being
    // refused at the id gate, which never runs for accessProfile !== 'peer'.
    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'freeform-id-not-ctx-shaped',
        taskId: 'freeform-task-id',
        taskSpec: TASK_SPEC,
        protocolVersion: 3,
        worktree: 'some-existing-worktree',
        agent: 'codex'
      }),
      ctx
    )) as { state: string; failedStage?: string }
    expect(result.state).not.toBe('agent_readiness')
    expect(result.failedStage).toBe('worktree_resolve')
    vi.restoreAllMocks()
  })
})

describe('S10-19 W3-T3/T4: full profile submit-byte strip + foreground liveness gate', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('W3-T3: taskSpec with embedded submit bytes is stripped before the paste', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_full_worker',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_full_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote:leaf_remote')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_full_worker:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'isPeerPaneForegroundAgentLive').mockResolvedValue(true)
    const sendPrompt = vi
      .spyOn(runtime, 'sendTerminalAgentPrompt')
      .mockResolvedValue({ handle: 'term_full_worker', accepted: true, bytesWritten: 1 })

    const method = findMethod('orchestration.federationAttachStart')
    const dirtyTaskSpec = 'line one\r\nline two\x04done'
    await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_dddddddddddd',
        taskId: 'task_dddddddddddd',
        taskSpec: dirtyTaskSpec,
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_full',
          requestId: 'request_full_1',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'full_payload_1'
        }
      }
    )
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const [, promptText, options] = sendPrompt.mock.calls[0]!
    expect(promptText).not.toContain('\r')
    expect(promptText).not.toContain('\x04')
    expect(promptText).toContain('line oneline two')
    expect(options).toMatchObject({ beforeWrite: expect.any(Function) })
  })

  it('W3-T4: a not-live foreground fails the write via beforeWrite and the receipt classifies known', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_full_worker2',
      worktreeId: 'folder:remote-workspace',
      title: 'worker'
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_full_worker2',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_remote2:leaf_remote2')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
      'runtime_test:term_full_worker2:1'
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    // Why this proves the design point, not just the mock: isPeerPaneForegroundAgentLive is the
    // ONLY thing this beforeWrite trusts — the stale tui-idle wait above already reported satisfied.
    vi.spyOn(runtime, 'isPeerPaneForegroundAgentLive').mockResolvedValue(false)
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (_h, _p, options) => {
      await options?.beforeWrite?.('pty_x')
      return { handle: 'term_full_worker2', accepted: true, bytesWritten: 0 }
    })

    const method = findMethod('orchestration.federationAttachStart')
    const result = (await method.handler(
      method.params!.parse({
        dispatchId: 'ctx_eeeeeeeeeeee',
        taskId: 'task_eeeeeeeeeeee',
        taskSpec: TASK_SPEC,
        protocolVersion: 3,
        worktree: 'folder:remote-workspace',
        agent: 'codex'
      }),
      {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'home_full',
          requestId: 'request_full_2',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'full_payload_2'
        }
      }
    )) as { state: string; lastError?: string }

    expect(result.state).not.toBe('ready')
    expect(result.lastError).toContain('agent_not_live')
  })
})

describe('S10-19 S-9: the S10-20 id grammar is imported by name, not copied', () => {
  it('runtime-peer-rpc-allowlist.ts imports isHostScopedId from the S10-20 grammar module', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL('./runtime-peer-rpc-allowlist.ts', import.meta.url),
      'utf-8'
    )
    expect(source).toMatch(/isHostScopedId/)
    expect(source).toMatch(/from '\.\/orchestration\/orchestration-id-grammar'/)
  })
})
