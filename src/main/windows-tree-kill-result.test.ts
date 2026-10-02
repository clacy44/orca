import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateWindowsProcessTreeReportingExit } from './windows-process-tree-kill'

type ExecCallback = (error: (Error & { code?: unknown }) | null) => void
const execImpl = (outcome: (Error & { code?: unknown }) | null) =>
  vi.fn((_cmd: string, _args: readonly string[], _options: unknown, callback: ExecCallback) => {
    callback(outcome)
  }) as never

afterEach(() => {
  vi.restoreAllMocks()
})

describe('F5: terminateWindowsProcessTreeReportingExit', () => {
  it('reports taskkill exit 0', async () => {
    await expect(
      terminateWindowsProcessTreeReportingExit(1234, { execFileImpl: execImpl(null) })
    ).resolves.toEqual({ exitCode: 0 })
  })

  it('reports a non-zero taskkill exit code', async () => {
    const failure = Object.assign(new Error('not found'), { code: 128 })
    await expect(
      terminateWindowsProcessTreeReportingExit(55, { execFileImpl: execImpl(failure) })
    ).resolves.toEqual({ exitCode: 128 })
  })

  it('reports a spawn error as exitCode null and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' })

    await expect(
      terminateWindowsProcessTreeReportingExit(55, { execFileImpl: execImpl(failure) })
    ).resolves.toEqual({ exitCode: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taskkill'))
  })

  it('reports exitCode null for an invalid pid without running taskkill', async () => {
    const execFileImpl = vi.fn()
    await expect(
      terminateWindowsProcessTreeReportingExit(0, { execFileImpl: execFileImpl as never })
    ).resolves.toEqual({ exitCode: null })
    expect(execFileImpl).not.toHaveBeenCalled()
  })
})
