// F1 (G1): the Windows process query carries CreationDate so a PID-reuse cycle is cut by age.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessDescendants,
  resetWindowsProcessRowsSnapshotForTests
} from './windows-foreground-process-rows'

type ExecFileCallback = (err: unknown, result: { stdout: string; stderr: string }) => void

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

function jsonRow(pid: number, ppid: number, name: string, created: unknown) {
  return {
    ProcessId: pid,
    ParentProcessId: ppid,
    Name: name,
    CommandLine: name,
    ExecutablePath: `C:/x/${name}`,
    CreationDate: created
  }
}

describe('windows process query CreationDate', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('asks CIM for CreationDate', async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: ExecFileCallback) =>
      cb(null, { stdout: JSON.stringify([jsonRow(1, 0, 'a.exe', null)]), stderr: '' })
    )
    await queryWindowsProcessDescendants(1)
    const psArgs = execFileMock.mock.calls[0][1] as string[]
    expect(psArgs.join(' ')).toContain('CreationDate')
  })

  it('cuts a PID-reuse cycle by creation time, accepting both JSON date shapes', async () => {
    // shell 600 -> claude 6996 (recycled PID of explorer's dead parent); explorer is older than it.
    const rows = [
      jsonRow(7000, 6996, 'explorer.exe', `/Date(${T0})/`),
      jsonRow(910, 7000, 'chrome.exe', `/Date(${T0 + 10})/`),
      jsonRow(400, 7000, 'electron.exe', new Date(T0 + 100).toISOString()),
      jsonRow(500, 400, 'node.exe', new Date(T0 + 200).toISOString()),
      jsonRow(600, 500, 'pwsh.exe', new Date(T0 + 300).toISOString()),
      jsonRow(6996, 600, 'node.exe', new Date(T0 + 400).toISOString()),
      jsonRow(800, 6996, 'sh.exe', new Date(T0 + 500).toISOString())
    ]
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: ExecFileCallback) =>
      cb(null, { stdout: JSON.stringify(rows), stderr: '' })
    )
    const onTreeAnomaly = vi.fn()
    const candidates = await queryWindowsProcessDescendants(600, { onTreeAnomaly })
    expect(candidates?.map((c) => c.pid).sort((a, b) => a - b)).toEqual([800, 6996])
    expect(onTreeAnomaly.mock.calls[0][0]).toMatchObject({
      staleEdgesSkipped: 1,
      cutBy: 'creation-time'
    })
  })

  it('parses the wmic CreationDate shape on the fallback path', async () => {
    const wmic = (pid: number, ppid: number, name: string, created: string): string =>
      `CommandLine=${name}\nCreationDate=${created}\nExecutablePath=C:/x/${name}\nName=${name}\nParentProcessId=${ppid}\nProcessId=${pid}\n\n`
    const stdout =
      wmic(500, 400, 'node.exe', '20261001120000.000000+000') +
      wmic(600, 500, 'pwsh.exe', '20261001120100.000000+000') +
      wmic(700, 600, 'cmd.exe', '20261001120200.000000+000') +
      wmic(400, 700, 'claude.exe', '20261001120300.000000+000')
    execFileMock.mockImplementation(
      (cmd: string, _a: string[], _o: unknown, cb: ExecFileCallback) => {
        if (cmd === 'powershell.exe') {
          cb(new Error('no powershell'), { stdout: '', stderr: '' })
          return
        }
        cb(null, { stdout, stderr: '' })
      }
    )
    const onTreeAnomaly = vi.fn()
    const candidates = await queryWindowsProcessDescendants(600, { onTreeAnomaly })
    expect(candidates?.map((c) => c.pid).sort((a, b) => a - b)).toEqual([400, 700])
    expect(onTreeAnomaly.mock.calls[0][0]).toMatchObject({ cutBy: 'creation-time' })
  })
})
