/**
 * `ptyController.spawn` can re-point a create at a canonical or stable-owner pane. That redirect is
 * an adopt of a pane the mint-time gate never saw, so it owes the gate a pass — and the record must
 * take the lane of the pane the process actually lives in, never the caller's (S9 §2a, §5).
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
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const WORKTREE = 'wt-1'
const HINTED_TAB = 'hinted-tab'
const HINTED_LEAF = '33333333-3333-4333-8333-333333333333'

const principals: PrincipalLookup = {
  principalOf: (deviceId) =>
    deviceId === 'device-a' ? PRINCIPAL_A : deviceId === 'device-b' ? PRINCIPAL_B : null,
  linkPrincipalOf: () => null
}

type SpawnArgs = { tabId?: string; leafId?: string }
type Redirect = { handle: string; tabId: string; leafId: string } | null

function createRuntime(): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  forgetPaneCredentialLane: ReturnType<typeof vi.fn>
  setRedirect: (redirect: Redirect) => void
} {
  const forgetPaneCredentialLane = vi.fn()
  const runtime = new OrcaRuntimeService({
    getPaneCredentialLanes: () => ({}),
    persistPaneCredentialLane: vi.fn(),
    forgetPaneCredentialLane
  } as never)
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
  let redirect: Redirect = null
  const spawn = vi.fn().mockImplementation(async (args: SpawnArgs) => ({
    id: `pty-${args.tabId}-${args.leafId}`,
    ...(redirect ? { stablePaneOwner: redirect } : {})
  }))
  const kill = vi.fn().mockReturnValue(true)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null
  })
  return {
    runtime,
    spawn,
    kill,
    forgetPaneCredentialLane,
    setRedirect: (next) => {
      redirect = next
    }
  }
}

async function ownerPane(
  runtime: OrcaRuntimeService,
  spawn: ReturnType<typeof vi.fn>
): Promise<{ tabId: string; leafId: string; handle: string }> {
  const created = await runtime.createTerminal(`id:${WORKTREE}`, {
    restoreProvenance: { kind: 'none' },
    credentialLane: runtime.resolveCallerCredentialLane('device-a')
  })
  const { tabId, leafId } = spawn.mock.calls[0][0] as { tabId: string; leafId: string }
  spawn.mockClear()
  return { tabId, leafId, handle: created.handle }
}

function lanePrincipalIdOfPty(runtime: OrcaRuntimeService, ptyId: string): string | null {
  const record = (
    runtime as unknown as { ptysById: Map<string, { lanePrincipalId?: string | null }> }
  ).ptysById.get(ptyId)
  return record?.lanePrincipalId ?? null
}

describe('createTerminal — the post-spawn pane redirect', () => {
  it('refuses grant B when the spawn lands on grant A’s lane pane, and kills the process', async () => {
    const { runtime, spawn, kill, setRedirect } = createRuntime()
    const owner = await ownerPane(runtime, spawn)
    setRedirect({ handle: owner.handle, tabId: owner.tabId, leafId: owner.leafId })

    const refusal = await runtime
      .createTerminal(`id:${WORKTREE}`, {
        restoreProvenance: { kind: 'none' },
        credentialLane: runtime.resolveCallerCredentialLane('device-b')
      })
      .then(() => 'no-refusal')
      .catch((error: unknown) => (isClaudeLaneRefusal(error) ? error.code : String(error)))

    expect(refusal).toBe('terminal.lane_not_owned')
    const { tabId, leafId } = spawn.mock.calls[0][0] as { tabId: string; leafId: string }
    expect(kill).toHaveBeenCalledWith(`pty-${tabId}-${leafId}`)
    // The redirected pane keeps A's lane; the pane B minted and never used keeps no row at all.
    expect(runtime.paneCredentialLaneLookup(WORKTREE, owner.tabId, owner.leafId)).toEqual({
      kind: 'bound',
      lane: { kind: 'principal', principalId: PRINCIPAL_A }
    })
    expect(runtime.paneCredentialLaneLookup(WORKTREE, tabId, leafId)).toEqual({ kind: 'unknown' })
  })

  it('gives the record the redirected pane’s lane, not the caller’s', async () => {
    const { runtime, spawn, setRedirect } = createRuntime()
    const owner = await ownerPane(runtime, spawn)
    setRedirect({ handle: owner.handle, tabId: owner.tabId, leafId: owner.leafId })

    await runtime.createTerminal(`id:${WORKTREE}`, {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-a')
    })

    const { tabId, leafId } = spawn.mock.calls[0][0] as { tabId: string; leafId: string }
    expect(lanePrincipalIdOfPty(runtime, `pty-${tabId}-${leafId}`)).toBe(PRINCIPAL_A)
  })

  it('refuses a lane-less caller redirected onto a lane-bound pane', async () => {
    const { runtime, spawn, kill, setRedirect } = createRuntime()
    const owner = await ownerPane(runtime, spawn)
    setRedirect({ handle: owner.handle, tabId: owner.tabId, leafId: owner.leafId })

    const refusal = await runtime
      .createTerminal(`id:${WORKTREE}`, {
        restoreProvenance: { kind: 'none' },
        credentialLane: { kind: 'shared' }
      })
      .then(() => 'no-refusal')
      .catch((error: unknown) => (isClaudeLaneRefusal(error) ? error.code : String(error)))

    expect(refusal).toBe('terminal.lane_not_owned')
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('releases the row it minted for a client-hinted identity when the redirect is refused', async () => {
    const { runtime, spawn, setRedirect, forgetPaneCredentialLane } = createRuntime()
    const owner = await ownerPane(runtime, spawn)
    setRedirect({ handle: owner.handle, tabId: owner.tabId, leafId: owner.leafId })

    const refusal = await runtime
      .createTerminal(`id:${WORKTREE}`, {
        restoreProvenance: { kind: 'none' },
        credentialLane: runtime.resolveCallerCredentialLane('device-b'),
        tabId: HINTED_TAB,
        leafId: HINTED_LEAF
      })
      .then(() => 'no-refusal')
      .catch((error: unknown) => (isClaudeLaneRefusal(error) ? error.code : String(error)))

    expect(refusal).toBe('terminal.lane_not_owned')
    // Why: the funnel minted this row itself at the pre-spawn bind, so a refused redirect must
    // leave no bound pane behind — in memory or in the store the next rehydrate reads.
    expect(runtime.paneCredentialLaneLookup(WORKTREE, HINTED_TAB, HINTED_LEAF)).toEqual({
      kind: 'unknown'
    })
    expect(forgetPaneCredentialLane).toHaveBeenCalledWith({
      worktreeId: WORKTREE,
      tabId: HINTED_TAB,
      leafId: HINTED_LEAF
    })
  })

  it('leaves an unredirected create on the lane it bound at the mint', async () => {
    const { runtime, spawn } = createRuntime()

    await runtime.createTerminal(`id:${WORKTREE}`, {
      restoreProvenance: { kind: 'none' },
      credentialLane: runtime.resolveCallerCredentialLane('device-b')
    })

    const { tabId, leafId } = spawn.mock.calls[0][0] as { tabId: string; leafId: string }
    expect(lanePrincipalIdOfPty(runtime, `pty-${tabId}-${leafId}`)).toBe(PRINCIPAL_B)
  })
})
