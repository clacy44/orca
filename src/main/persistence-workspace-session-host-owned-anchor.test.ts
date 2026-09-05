/**
 * [S10-21a C12b, D-R125 F1 — HIGH] The launch-token anchor map
 * (`terminalLaunchTokenHashesByPaneKey`) is host-written only (`persistTerminalLaunchTokenHash`/
 * `forgetTerminalLaunchTokenHash`) and is consulted by `orca-runtime.ts`'s corroboration fallback
 * to decide whether a hook report's claimed authority is trustworthy. Before this fix, a
 * `session:set` write (renderer/relay-originated) replaced the whole map wholesale — a caller
 * could plant its own hash for a pane it does not own, then have a later hook report for that
 * pane read back as corroborated. `setLocalWorkspaceSession`/`setHostWorkspaceSession` now make
 * the field host-wins: the incoming value is discarded outright, the prior (host-written) value
 * is kept. This regression test drives the REAL `Store` class end to end through
 * `setWorkspaceSession` (the same call `session:set`'s IPC handler makes) — no double on the
 * boundary under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-1111111111aa'
const PANE_A = `${TAB}:${LEAF}`
const HOST_HASH = 'host-written-hash'
const ATTACKER_HASH = 'attacker-supplied-hash'

async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-anchor-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('S10-21a C12b, D-R125 F1: the launch-token anchor map is host-owned end to end', () => {
  it("a session:set payload carrying a hash for an already-anchored pane leaves the host's value in place — the incoming map is discarded, not merged", async () => {
    const store = await createStore()
    // The host mints its OWN anchor for PANE_A first, exactly as a real launch does.
    store.persistTerminalLaunchTokenHash({ tabId: TAB, leafId: LEAF, launchTokenHash: HOST_HASH })
    expect(store.getWorkspaceSession().terminalLaunchTokenHashesByPaneKey?.[PANE_A]).toBe(HOST_HASH)

    // A session:set write (what the IPC handler forwards from the renderer) carries an
    // ATTACKER-CHOSEN hash for the SAME pane.
    const current = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...current,
      terminalLaunchTokenHashesByPaneKey: {
        ...current.terminalLaunchTokenHashesByPaneKey,
        [PANE_A]: ATTACKER_HASH
      }
    })

    // Host-wins: the stored map's PANE_A entry is still the host's prior value, not the
    // attacker-supplied one — the corroboration fallback (orca-runtime.ts) therefore reads the
    // host's value, never a caller-planted one.
    expect(store.getWorkspaceSession().terminalLaunchTokenHashesByPaneKey?.[PANE_A]).toBe(HOST_HASH)
  })

  it('a session:set payload carrying a hash for a pane with NO prior host anchor leaves it absent — never adopted from the incoming write', async () => {
    const store = await createStore()
    const current = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...current,
      terminalLaunchTokenHashesByPaneKey: { [PANE_A]: ATTACKER_HASH }
    })

    expect(store.getWorkspaceSession().terminalLaunchTokenHashesByPaneKey?.[PANE_A]).toBeUndefined()
  })

  it('same treatment for a non-local (SSH) partition: setWorkspaceSession(hostId) discards the incoming anchor map too', async () => {
    const store = await createStore()
    const sshHostId = 'ssh:test-host'
    // Seed the SSH partition's own host-written anchor the same way a real launch there does.
    store.persistTerminalLaunchTokenHash(
      { tabId: TAB, leafId: LEAF, launchTokenHash: HOST_HASH },
      sshHostId
    )
    expect(store.getWorkspaceSession(sshHostId).terminalLaunchTokenHashesByPaneKey?.[PANE_A]).toBe(
      HOST_HASH
    )

    const current = store.getWorkspaceSession(sshHostId)
    store.setWorkspaceSession(
      {
        ...current,
        terminalLaunchTokenHashesByPaneKey: {
          ...current.terminalLaunchTokenHashesByPaneKey,
          [PANE_A]: ATTACKER_HASH
        }
      },
      sshHostId
    )

    expect(store.getWorkspaceSession(sshHostId).terminalLaunchTokenHashesByPaneKey?.[PANE_A]).toBe(
      HOST_HASH
    )
  })
})
