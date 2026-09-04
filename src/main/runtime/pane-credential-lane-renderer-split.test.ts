/**
 * `terminal.split` has a second door: when the parent's PTY has exited but its leaf survives, the
 * split is notified to the renderer, which mints an anonymous pane the host cannot pin to a lane.
 * That branch fails closed rather than producing a shared-credential child of a lane pane (§2a, §3).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const WORKTREE = 'wt-1'

const principals: PrincipalLookup = {
  principalOf: (deviceId) =>
    deviceId === 'device-a'
      ? PRINCIPAL_A
      : deviceId === 'device-b'
        ? '22222222-2222-4222-8222-222222222222'
        : null,
  linkPrincipalOf: () => null
}

type InternalMethods = Record<string, (...args: never[]) => unknown>

async function exitedLanePane(callerDeviceId: string | undefined): Promise<{
  runtime: OrcaRuntimeService
  splitTerminal: ReturnType<typeof vi.fn>
  handle: string
}> {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as { resolveTerminalWorkspaceLaunchScope: () => Promise<unknown> },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: WORKTREE,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPrincipalLaneLookup(principals)
  const spawn = vi.fn().mockImplementation(async (args: { tabId?: string; leafId?: string }) => ({
    id: `pty-${args.tabId}-${args.leafId}`
  }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const created = await runtime.createTerminal(`id:${WORKTREE}`, {
    restoreProvenance: { kind: 'none' },
    credentialLane: runtime.resolveCallerCredentialLane(callerDeviceId)
  })
  const { tabId, leafId } = spawn.mock.calls[0][0] as { tabId: string; leafId: string }

  // The pane's process has exited; only its renderer leaf survives.
  vi.spyOn(runtime as unknown as InternalMethods, 'getLivePtyForHandle').mockReturnValue(
    null as never
  )
  vi.spyOn(runtime as unknown as InternalMethods, 'assertGraphReady').mockReturnValue(
    undefined as never
  )
  vi.spyOn(runtime as unknown as InternalMethods, 'getLiveLeafForHandle').mockReturnValue({
    leaf: { tabId, leafId, worktreeId: WORKTREE, paneRuntimeId: 7 }
  } as never)
  vi.spyOn(runtime as unknown as InternalMethods, 'waitForNewLeafInTab').mockResolvedValue(
    'term-new' as never
  )
  const splitTerminal = vi.fn()
  runtime.setNotifier({ splitTerminal } as never)
  return { runtime, splitTerminal, handle: created.handle }
}

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no-refusal'
}

describe('splitTerminal — the renderer-notified branch', () => {
  it('fails closed for the lane pane’s own principal, and notifies nothing', async () => {
    const { runtime, splitTerminal, handle } = await exitedLanePane('device-a')

    expect(
      await refusalOf(() => runtime.splitTerminal(handle, { pairedDeviceId: 'device-a' }))
    ).toBe('terminal.lane_renderer_split_unsupported')
    expect(splitTerminal).not.toHaveBeenCalled()
  })

  it('refuses another principal at the ownership predicate before that', async () => {
    const { runtime, splitTerminal, handle } = await exitedLanePane('device-a')

    expect(
      await refusalOf(() => runtime.splitTerminal(handle, { pairedDeviceId: 'device-b' }))
    ).toBe('terminal.lane_not_owned')
    expect(splitTerminal).not.toHaveBeenCalled()
  })

  it('still notifies the renderer for a shared-lane pane', async () => {
    const { runtime, splitTerminal, handle } = await exitedLanePane(undefined)

    await runtime.splitTerminal(handle, {})

    expect(splitTerminal).toHaveBeenCalledTimes(1)
  })
})
