/**
 * An SSH/relay pane must never receive a lane path, and after the lane was decoupled from
 * `isClaudeLaunch` that guard has to be explicit: `connectionId` is a condition of the lane
 * *value*, not of where its row is filed (S9 §2a, §2h).
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
const WORKTREE = 'wt-ssh'

const principals: PrincipalLookup = {
  principalOf: (deviceId) => (deviceId === 'device-a' ? PRINCIPAL_A : null),
  linkPrincipalOf: () => null
}

function createRuntime(connectionId: string | null): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
  persistPaneCredentialLane: ReturnType<typeof vi.fn>
} {
  const persistPaneCredentialLane = vi.fn()
  const runtime = new OrcaRuntimeService({
    getPaneCredentialLanes: () => ({}),
    persistPaneCredentialLane
  } as never)
  vi.spyOn(
    runtime as unknown as { resolveTerminalWorkspaceLaunchScope: () => Promise<unknown> },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: WORKTREE,
    path: '/repo/app',
    connectionId,
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
  return { runtime, spawn, persistPaneCredentialLane }
}

function lanePrincipalIdOfPty(runtime: OrcaRuntimeService, ptyId: string): string | null {
  const record = (
    runtime as unknown as { ptysById: Map<string, { lanePrincipalId?: string | null }> }
  ).ptysById.get(ptyId)
  return record?.lanePrincipalId ?? null
}

describe('createTerminal — an SSH-backed workspace', () => {
  it('binds a lane holder’s remote pane to the shared lane and stamps no principal on it', async () => {
    const { runtime, spawn } = createRuntime('conn-1')

    const created = await runtime.createTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup(WORKTREE, tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'shared' }
    })
    expect(lanePrincipalIdOfPty(runtime, `pty-${tabId}-${leafId}`)).toBeNull()
    expect(created.handle).toBeTruthy()
  })

  it('still binds a local pane of the same caller to that caller’s lane', async () => {
    const { runtime, spawn } = createRuntime(null)

    await runtime.createTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup(WORKTREE, tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
    expect(lanePrincipalIdOfPty(runtime, `pty-${tabId}-${leafId}`)).toBe(PRINCIPAL_A)
  })

  it('files no lane row for a remote pane in the local session partition', async () => {
    const { runtime, persistPaneCredentialLane } = createRuntime('conn-1')

    await runtime.createTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    expect(persistPaneCredentialLane).not.toHaveBeenCalled()
  })

  it('lets a lane holder split their own remote pane rather than refusing it', async () => {
    const { runtime, spawn } = createRuntime('conn-1')
    const created = await runtime.createTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })
    spawn.mockClear()

    // Why: the parent carries no lane by construction, so there is no credential to own — the
    // predicate would only refuse a legitimate remote split.
    const split = await runtime.splitTerminal(created.handle, { pairedDeviceId: 'device-a' })

    expect(split.handle).toBeTruthy()
    const { tabId, leafId } = spawn.mock.calls[0][0]
    expect(runtime.paneCredentialLaneLookup(WORKTREE, tabId, leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'shared' }
    })
  })

  it('refuses the same split when the parent is a local pane of another principal', async () => {
    const { runtime } = createRuntime(null)
    const created = await runtime.createTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    const refusal = await runtime
      .splitTerminal(created.handle, { pairedDeviceId: 'device-b' })
      .then(() => 'no-refusal')
      .catch((error: unknown) => (isClaudeLaneRefusal(error) ? error.code : String(error)))

    expect(refusal).toBe('terminal.lane_not_owned')
  })
})
