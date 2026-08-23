/**
 * `session.tabs.createTerminal` and `session.tabs.activate` reach the same host create, and they
 * must not be treated the same: the create drops a renderer-minted identity for a lane caller,
 * while the activate/materialize *keeps* it and leans on the adopt gate (S9 §2a(i), row 35).
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { PrincipalLookup } from './terminal-credential-lane-resolution'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const WORKTREE = 'wt-1'
const TAB = 'tab-1'
const LEAF = 'leaf-1'

const principals: PrincipalLookup = {
  principalOf: (deviceId) => (deviceId === 'device-a' ? PRINCIPAL_A : null),
  linkPrincipalOf: () => null
}

type Internals = Record<string, unknown>

type InternalMethods = Record<string, (...args: never[]) => unknown>

function spyOnInternal(runtime: OrcaRuntimeService, name: string) {
  return vi.spyOn(runtime as unknown as InternalMethods, name)
}

function createRuntime(): { runtime: OrcaRuntimeService; hostCreate: ReturnType<typeof vi.fn> } {
  const runtime = new OrcaRuntimeService()
  runtime.setPrincipalLaneLookup(principals)
  const internals = runtime as unknown as Internals
  spyOnInternal(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: WORKTREE,
    path: '/repo/app',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  } as never)
  spyOnInternal(runtime, 'hydrateHeadlessMobileSessionTabsFromWorkspaceSession').mockReturnValue(
    undefined as never
  )
  spyOnInternal(runtime, 'resolveMobileSessionTerminalCommand').mockResolvedValue({} as never)
  spyOnInternal(runtime, 'captureReadyGraphEpoch').mockReturnValue(1 as never)
  spyOnInternal(runtime, 'assertStableReadyGraph').mockReturnValue(undefined as never)
  const hostCreate = vi
    .fn()
    .mockResolvedValue({ tab: { id: TAB, parentTabId: TAB, leafId: LEAF }, tabs: [] })
  ;(
    internals as { createRuntimeOwnedMobileSessionTerminal: unknown }
  ).createRuntimeOwnedMobileSessionTerminal = hostCreate
  return { runtime, hostCreate }
}

describe('session.tabs.createTerminal — the branch inversion', () => {
  it('routes a lane caller to the host create even with an authoritative window present', async () => {
    const { runtime, hostCreate } = createRuntime()
    const send = vi.fn()
    vi.spyOn(
      runtime as unknown as { getAvailableAuthoritativeWindow: () => unknown },
      'getAvailableAuthoritativeWindow'
    ).mockReturnValue({ webContents: { send, isDestroyed: () => false } })

    await runtime.createMobileSessionTerminal(`id:${WORKTREE}`, {
      credentialLane: runtime.resolveCallerCredentialLane('device-a'),
      select: false
    })

    expect(send).not.toHaveBeenCalled()
    expect(hostCreate).toHaveBeenCalledTimes(1)
    const opts = hostCreate.mock.calls[0][3]
    expect(opts.credentialLane).toEqual({ kind: 'principal', principalId: PRINCIPAL_A })
    // Why: the host mints the pane for a lane caller, so no renderer identity is adopted.
    expect(opts.identity).toBeUndefined()
  })

  it('leaves a lane-less caller on the renderer branch', async () => {
    const { runtime, hostCreate } = createRuntime()
    const send = vi.fn()
    vi.spyOn(
      runtime as unknown as { getAvailableAuthoritativeWindow: () => unknown },
      'getAvailableAuthoritativeWindow'
    ).mockReturnValue({ webContents: { send, isDestroyed: () => false } })

    await runtime
      .createMobileSessionTerminal(`id:${WORKTREE}`, {
        credentialLane: runtime.resolveCallerCredentialLane('device-unbound'),
        select: false
      })
      .catch(() => undefined)

    expect(hostCreate).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
  })
})

describe('session.tabs.activate — the materialize', () => {
  function stubPendingTab(runtime: OrcaRuntimeService): void {
    const internals = runtime as unknown as Internals
    const tab = {
      id: `${TAB}:${LEAF}`,
      type: 'terminal' as const,
      parentTabId: TAB,
      leafId: LEAF,
      worktreeId: WORKTREE,
      ptyId: 'pty-slept'
    }
    ;(
      internals as { mobileSessionTabsByWorktree: Map<string, unknown> }
    ).mobileSessionTabsByWorktree.set(WORKTREE, { tabs: [tab], tabGroups: [] })
    spyOnInternal(runtime, 'getValidatedExplicitWorktreeIdSelector').mockReturnValue(
      WORKTREE as never
    )
    spyOnInternal(runtime, 'refreshMobileSessionPtyRecords').mockResolvedValue(undefined as never)
    spyOnInternal(runtime, 'toMobileSessionTabsResult').mockReturnValue({
      tabs: [{ ...tab, status: 'pending' }]
    } as never)
    spyOnInternal(runtime, 'shouldMaterializeHeadlessMobileSessionTab').mockReturnValue(
      true as never
    )
    spyOnInternal(runtime, 'getMobileSessionTabsForWorktree').mockReturnValue({
      tabs: []
    } as never)
    spyOnInternal(runtime, 'applyMobileSessionTabNavigation').mockReturnValue({
      tabs: []
    } as never)
  }

  it('keeps the renderer-minted identity so the tapped pane is reattached, not duplicated', async () => {
    const { runtime, hostCreate } = createRuntime()
    stubPendingTab(runtime)

    await runtime.activateMobileSessionTab(`id:${WORKTREE}`, TAB, LEAF, {
      pairedDeviceId: 'device-a'
    })

    expect(hostCreate).toHaveBeenCalledTimes(1)
    const opts = hostCreate.mock.calls[0][3]
    expect(opts.identity).toEqual({ tabId: TAB, leafId: LEAF, sessionId: 'pty-slept' })
    expect(opts.credentialLane).toEqual({ kind: 'principal', principalId: PRINCIPAL_A })
  })

  it('spends the tap’s pairedDeviceId as caller identity, not only as a navigation id', async () => {
    const { runtime, hostCreate } = createRuntime()
    stubPendingTab(runtime)

    await runtime.activateMobileSessionTab(`id:${WORKTREE}`, TAB, LEAF, {})

    expect(hostCreate.mock.calls[0][3].credentialLane).toEqual({ kind: 'shared' })
  })
})
