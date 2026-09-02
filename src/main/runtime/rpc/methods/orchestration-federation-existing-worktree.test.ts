// S10-19 W-3 review finding 7: a createTerminal failure on the "reuse an existing worktree,
// spawn a fresh terminal" branch must report failedStage 'terminal_create', not the leftover
// default 'worktree_resolve' — the caller's setFailedStage callback fires synchronously right
// before the call that can throw, mirroring the base commit's "set the stage, then call" order.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { resolveExistingFederatedWorktree } from './orchestration-federation-existing-worktree'

describe('S10-19 W-3 review finding 7: resolveExistingFederatedWorktree failedStage reporting', () => {
  it('a createTerminal failure reports terminal_create via setFailedStage before the throw propagates', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'wt-1',
      repoId: 'repo-1'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockRejectedValue(new Error('spawn failed'))

    const stages: string[] = []
    await expect(
      resolveExistingFederatedWorktree({
        runtime,
        worktreeSelector: 'id:wt-1',
        isPeerCaller: false,
        credentialLane: { kind: 'none' } as never,
        agent: undefined,
        launch: { receipt: {}, preferences: undefined } as never,
        terminalHandle: undefined,
        taskId: 'task_x',
        effects: [],
        setFailedStage: (stage) => stages.push(stage)
      })
    ).rejects.toThrow('spawn failed')

    expect(stages).toEqual(['terminal_create'])
  })

  it('reusing an existing terminal handle never calls setFailedStage (no create attempted)', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'wt-1',
      repoId: 'repo-1'
    } as never)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt-1' } as never)
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const stages: string[] = []
    const result = await resolveExistingFederatedWorktree({
      runtime,
      worktreeSelector: 'id:wt-1',
      isPeerCaller: false,
      credentialLane: { kind: 'none' } as never,
      agent: undefined,
      launch: { receipt: {}, preferences: undefined } as never,
      terminalHandle: 'term_existing',
      taskId: 'task_x',
      effects: [],
      setFailedStage: (stage) => stages.push(stage)
    })

    expect(result.terminalHandle).toBe('term_existing')
    expect(stages).toEqual([])
    expect(createTerminal).not.toHaveBeenCalled()
  })
})

describe('W-5..W-7 review · worktree oracle (Ruling 24(z)) / NEG-14', () => {
  async function refusalFor(exists: boolean) {
    const runtime = new OrcaRuntimeService()
    if (exists) {
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
        id: 'wt-1',
        repoId: 'repo-not-federated'
      } as never)
    } else {
      vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockRejectedValue(new Error('not found'))
    }
    vi.spyOn(runtime, 'getFederationDispatchRepos').mockReturnValue([])
    try {
      await resolveExistingFederatedWorktree({
        runtime,
        worktreeSelector: 'id:wt-1',
        isPeerCaller: true,
        credentialLane: { kind: 'none' } as never,
        agent: undefined,
        launch: { receipt: {}, preferences: undefined } as never,
        terminalHandle: undefined,
        taskId: 'task_x',
        effects: [],
        setFailedStage: () => {}
      })
      throw new Error('expected a refusal')
    } catch (error) {
      return error as { code: string; message: string; data?: unknown }
    }
  }

  it('a peer caller gets the byte-identical refusal whether the worktree exists (unfederated) or does not exist', async () => {
    const resolvedButUnfederated = await refusalFor(true)
    const didNotResolve = await refusalFor(false)

    expect(resolvedButUnfederated.code).toBe('forbidden')
    expect(didNotResolve.code).toBe('forbidden')
    expect(resolvedButUnfederated.message).toBe(didNotResolve.message)
    expect(resolvedButUnfederated.data).toEqual(didNotResolve.data)
    expect(resolvedButUnfederated.message).not.toContain('repo-not-federated')
  })
})
