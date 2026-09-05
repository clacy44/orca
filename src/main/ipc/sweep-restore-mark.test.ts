// S10-21a C15 (R52, D-V7 F1): `sweepRestoreMarkList` must answer the POST-SWEEP view, not
// whatever is in the table the instant it is asked (the sweep can still be running, C7b).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, awaitRestoreSweepLockReleaseMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  awaitRestoreSweepLockReleaseMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('../runtime/restore-sweep-lock', () => ({
  awaitRestoreSweepLockRelease: awaitRestoreSweepLockReleaseMock
}))

import { registerSweepRestoreMarkHandler } from './sweep-restore-mark'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { SweepRestoreMarkListReply } from '../../shared/sweep-restore-mark-list'

function makeRuntime(paneKeys: string[]): OrcaRuntimeService {
  return {
    getOrchestrationDb: () => ({
      listSweepRestoreMarks: vi.fn(() => paneKeys),
      getSweepRestoreMark: vi.fn(() => false)
    }),
    getOrchestrationCompatibilityHostId: () => 'host-1'
  } as unknown as OrcaRuntimeService
}

function getListHandler(): () => Promise<SweepRestoreMarkListReply> {
  const call = handleMock.mock.calls.find(
    (call: unknown[]) => call[0] === 'orchestration:sweepRestoreMark:list'
  )
  return call?.[1]
}

describe('orchestration:sweepRestoreMark:list', () => {
  beforeEach(() => {
    handleMock.mockReset()
    awaitRestoreSweepLockReleaseMock.mockReset()
  })

  it('resolves only after the sweep lock releases, with the post-release marks', async () => {
    let releaseLock: (() => void) | undefined
    awaitRestoreSweepLockReleaseMock.mockReturnValue(
      new Promise((resolve) => {
        releaseLock = () => resolve('released')
      })
    )
    registerSweepRestoreMarkHandler(makeRuntime(['pane-a']))

    let resolved = false
    const pending = getListHandler()().then((reply) => {
      resolved = true
      return reply
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)

    releaseLock?.()
    const reply = await pending
    expect(resolved).toBe(true)
    expect(reply).toEqual({ paneKeys: ['pane-a'] })
  })

  it('resolves with the current marks and sweepIncomplete:true on a lock-release timeout', async () => {
    awaitRestoreSweepLockReleaseMock.mockResolvedValue('timeout')
    registerSweepRestoreMarkHandler(makeRuntime(['pane-b']))

    const reply = await getListHandler()()

    expect(reply).toEqual({ paneKeys: ['pane-b'], sweepIncomplete: true })
  })
})
