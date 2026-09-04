// S10-21a C3-v2g, D-R105 LOW-2: `admitted.confirm(result)` runs AFTER `provider.spawn` already
// succeeded — the process is live. A throw from `confirm` itself must never route through the
// DELETING `compensate()` (that would destroy a row for a process provably still running); it
// gets its own catch, audits via `compensate(true)` (audit-only) and rethrows.
import { describe, expect, it, vi } from 'vitest'
import type { AdmittedLaunch } from './agent-launch-admission'

const { admitAgentLaunchMock } = vi.hoisted(() => ({ admitAgentLaunchMock: vi.fn() }))

vi.mock('./agent-launch-admission', () => ({ admitAgentLaunch: admitAgentLaunchMock }))

import { spawnWithLane } from './lane-pinned-spawn'
import type { IPtyProvider, PtySpawnOptions } from '../providers/pty-provider-contract'
import type { PtySpawnResult } from '../providers/pty-spawn-result'

function fakeProvider(result: PtySpawnResult): IPtyProvider {
  return { spawn: vi.fn(async () => result) } as unknown as IPtyProvider
}

describe('D-R105 LOW-2: spawnWithLane isolates a confirm() throw from the deleting compensate()', () => {
  it('provider.spawn succeeds, confirm() throws -> compensate(true) (audit only), rethrows, never compensate()', async () => {
    const confirmError = new Error('confirm blew up')
    const compensate = vi.fn()
    const confirm = vi.fn(() => {
      throw confirmError
    })
    const admitted: AdmittedLaunch = {
      spawnOptions: { cols: 80, rows: 24 },
      confirm,
      compensate
    }
    admitAgentLaunchMock.mockResolvedValue(admitted)
    const spawnResult: PtySpawnResult = { id: 'pty-low2' }
    const provider = fakeProvider(spawnResult)

    await expect(
      spawnWithLane(
        provider,
        { cols: 80, rows: 24 } as PtySpawnOptions,
        { kind: 'shared' },
        { getDb: () => undefined, launchAdmission: { kind: 'caller' }, ctx: {} as never }
      )
    ).rejects.toBe(confirmError)

    expect(confirm).toHaveBeenCalledWith(spawnResult)
    expect(compensate).toHaveBeenCalledOnce()
    expect(compensate).toHaveBeenCalledWith(true) // audit-only, never the deleting no-arg form
  })

  it('provider.spawn itself throws -> the deleting compensate() (no arg), confirm() never called', async () => {
    const spawnError = new Error('spawn blew up')
    const compensate = vi.fn()
    const confirm = vi.fn()
    const admitted: AdmittedLaunch = {
      spawnOptions: { cols: 80, rows: 24 },
      confirm,
      compensate
    }
    admitAgentLaunchMock.mockResolvedValue(admitted)
    const provider = {
      spawn: vi.fn(async () => {
        throw spawnError
      })
    } as unknown as IPtyProvider

    await expect(
      spawnWithLane(
        provider,
        { cols: 80, rows: 24 } as PtySpawnOptions,
        { kind: 'shared' },
        { getDb: () => undefined, launchAdmission: { kind: 'caller' }, ctx: {} as never }
      )
    ).rejects.toBe(spawnError)

    expect(confirm).not.toHaveBeenCalled()
    expect(compensate).toHaveBeenCalledOnce()
    expect(compensate).toHaveBeenCalledWith() // the deleting no-arg form
  })
})
