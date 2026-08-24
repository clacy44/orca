/**
 * The pane's lane is persisted with its binding row, and every writer that rewrites that row must
 * preserve it — a dropped lane on reattach is a silent downgrade to the shared credential (S9 §2h).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const PRINCIPAL_A = '11111111-1111-4111-8111-111111111111'
const PRINCIPAL_B = '22222222-2222-4222-8222-222222222222'
const WORKTREE = 'repo-1::wt-1'
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-1111111111bb'
const PANE_KEY = `${TAB}:${LEAF}`

async function createStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify(getDefaultPersistedState(testState.dir)),
    'utf-8'
  )
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-lane-rows-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('pane credential lane binding rows', () => {
  it('writes the lane once and never rewrites it', async () => {
    const store = await createStore()

    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_A
    })
    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_B
    })
    store.persistPaneCredentialLane({ worktreeId: WORKTREE, tabId: TAB, leafId: LEAF })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toEqual({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })
  })

  it('records an explicitly shared pane distinguishably from an unbound one', async () => {
    const store = await createStore()

    store.persistPaneCredentialLane({ worktreeId: WORKTREE, tabId: TAB, leafId: LEAF })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toEqual({ worktreeId: WORKTREE })
    expect(store.getPaneCredentialLanes()['other:pane']).toBeUndefined()
  })

  it('preserves the lane across all four persistPtyBinding writers', async () => {
    const store = await createStore()
    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_A
    })

    // Path A and path B: the spawn writers.
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      startupCwd: '/repo/app'
    })
    // The two reattach writers (`ipc/pty.ts` stable-pane fence, `ssh-relay-session.ts`) rewrite an
    // existing row from an owner record and carry no lane of their own.
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'pty-2',
      incarnationId: 'inc-2'
    })
    store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      ptyId: 'pty-3',
      incarnationId: 'inc-3'
    })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toEqual({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })
  })

  it('preserves the lane in a non-local host partition too', async () => {
    const store = await createStore()
    const hostId = 'ssh:conn-1'
    store.persistPaneCredentialLane(
      { worktreeId: WORKTREE, tabId: TAB, leafId: LEAF, principalId: PRINCIPAL_A },
      hostId
    )
    const session = store.getWorkspaceSession(hostId)

    store.setWorkspaceSession({ ...session, terminalCredentialLanesByPaneKey: undefined }, hostId)

    expect(store.getPaneCredentialLanes(hostId)[PANE_KEY]).toEqual({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })
  })

  it('preserves the lane across a renderer session write that carries no lane rows', async () => {
    const store = await createStore()
    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_A
    })
    const session = store.getWorkspaceSession()

    store.setWorkspaceSession({ ...session, terminalCredentialLanesByPaneKey: undefined })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toEqual({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })
  })

  it('refuses a paneKey the rest of the tree could never have written', async () => {
    const store = await createStore()

    // Why: this is a public Store method and the row it writes is the durable lane authority, so
    // it funnels through the same validation every other paneKey construction does.
    expect(() =>
      store.persistPaneCredentialLane({ worktreeId: WORKTREE, tabId: 'a:b', leafId: LEAF })
    ).toThrow()
    expect(() =>
      store.persistPaneCredentialLane({ worktreeId: WORKTREE, tabId: TAB, leafId: 'leaf-1' })
    ).toThrow()
    expect(store.getPaneCredentialLanes()).toEqual({})
  })

  it('drops a released row and does not resurrect it from the store', async () => {
    const store = await createStore()
    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_A
    })

    store.forgetPaneCredentialLane({ worktreeId: WORKTREE, tabId: TAB, leafId: LEAF })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toBeUndefined()
  })

  it('leaves another worktree’s row alone when the release names a different owner', async () => {
    const store = await createStore()
    store.persistPaneCredentialLane({
      worktreeId: WORKTREE,
      tabId: TAB,
      leafId: LEAF,
      principalId: PRINCIPAL_A
    })

    store.forgetPaneCredentialLane({ worktreeId: 'repo-1::wt-2', tabId: TAB, leafId: LEAF })

    expect(store.getPaneCredentialLanes()[PANE_KEY]).toEqual({
      worktreeId: WORKTREE,
      principalId: PRINCIPAL_A
    })
  })

  it('keeps a separator-less lane row when another worktree’s tabs are pruned', async () => {
    const store = await createStore()
    const removedWorktree = 'repo-1::wt-removed'
    const session = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: { [removedWorktree]: [{ id: 'nose', title: 'x' }] },
      // Why: `slice(0, lastIndexOf(':'))` on a key with no ':' yields 'nose' and would match the
      // removed tab, dropping a row whose tabId no caller ever wrote.
      terminalCredentialLanesByPaneKey: { nosep: { worktreeId: WORKTREE } }
    } as never)

    store.removeWorkspaceSessionStateForWorktree(removedWorktree)

    expect(store.getPaneCredentialLanes().nosep).toEqual({ worktreeId: WORKTREE })
  })
})
