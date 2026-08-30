/**
 * A terminal's role (S10 BUG 2) is keyed by paneKey, not handle, so it must survive a runtime
 * restart — the same durability contract the pane's credential lane already relies on.
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
const LEAF = '11111111-1111-4111-8111-1111111111bb'
const PANE_KEY = `${TAB}:${LEAF}`

// Why no pre-seeded file: a restart-persistence test needs the SECOND call to load what the
// FIRST call's flush actually wrote, not a freshly-stamped default state (unlike a fixture
// that only ever constructs one Store per test).
async function createStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-role-rows-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('terminal role persistence', () => {
  it('reads back the role it just set', async () => {
    const store = await createStore()

    store.persistTerminalRole({ tabId: TAB, leafId: LEAF, role: 'merge-restructure backend' })

    expect(store.getTerminalRoles()[PANE_KEY]).toBe('merge-restructure backend')
  })

  it('clears the role when set to null', async () => {
    const store = await createStore()

    store.persistTerminalRole({ tabId: TAB, leafId: LEAF, role: 'merge-restructure backend' })
    store.persistTerminalRole({ tabId: TAB, leafId: LEAF, role: null })

    expect(store.getTerminalRoles()[PANE_KEY]).toBeUndefined()
  })

  it('survives a runtime restart — a fresh Store reading the same on-disk state', async () => {
    const store = await createStore()
    store.persistTerminalRole({ tabId: TAB, leafId: LEAF, role: 'merge-restructure backend' })
    store.flushOrThrow()

    const reloaded = await createStore()

    expect(reloaded.getTerminalRoles()[PANE_KEY]).toBe('merge-restructure backend')
  })
})
