// S10-21a C7i (Ruling 34 Addendum 27): ONE controller-inventory round for the whole restore
// sweep, retried once on a null (transient failure) round. Pattern follows
// collect-incumbent-evidence.test.ts (the sibling impure-IO test for the same slice).
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

function makeStore() {
  return {
    getWorkspaceSession: vi.fn(() => undefined),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => []),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntime(listProcesses: () => Promise<{ id: string; cwd: string }[]>) {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(listProcesses)
  } as never)
  return runtime
}

describe('OrcaRuntimeService.takeControllerInventoryForSweep', () => {
  it('returns the round on a successful first fetch — no retry', async () => {
    const listProcesses = vi.fn(async () => [{ id: 'pty-1', cwd: '/tmp' }])
    const runtime = makeRuntime(listProcesses)

    const inventory = await runtime.takeControllerInventoryForSweep()

    expect(inventory).not.toBeNull()
    expect(inventory?.allLivePtyIds.has('pty-1')).toBe(true)
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('retries ONCE on a null round (transient failure) and returns the retry result', async () => {
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient controller failure'))
      .mockResolvedValueOnce([{ id: 'pty-2', cwd: '/tmp' }])
    const runtime = makeRuntime(listProcesses)

    const inventory = await runtime.takeControllerInventoryForSweep()

    expect(inventory).not.toBeNull()
    expect(inventory?.allLivePtyIds.has('pty-2')).toBe(true)
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('returns null after the retry ALSO fails — never fabricates an inventory', async () => {
    const listProcesses = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient controller failure'))
      .mockRejectedValueOnce(new Error('still failing'))
    const runtime = makeRuntime(listProcesses)

    const inventory = await runtime.takeControllerInventoryForSweep()

    expect(inventory).toBeNull()
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })
})
