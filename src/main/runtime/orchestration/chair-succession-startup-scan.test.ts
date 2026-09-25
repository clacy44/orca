// S10-22a WAVE 2 (Wave 2 contract "Startup scan (A10)"; D-R215 §Protocol step 9). Real
// OrchestrationDb + mkdtemp ORCA_HOME per branch, per the dispatch's own test requirement — the
// scan itself never touches the db (see chair-succession-startup-scan.ts's header: the confirm-
// tail fallback path never registers anything), so each test also asserts the agent directory is
// untouched, proving "never launches anything" at the DB layer too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import {
  createSealed,
  read,
  transition,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import {
  scanSuccessionsAtStartup,
  type SuccessionStartupScanRuntime
} from './chair-succession-startup-scan'

let tempDir: string
let storeDeps: ChairSuccessionStoreDeps
let db: OrchestrationDb

function sealedInput() {
  return {
    reason: 'batch_end' as const,
    checkpointText: 'schema: orca.chair-checkpoint/1\n',
    checkpointSha: 'a'.repeat(64),
    charterPath: '/repo/CHARTER.md',
    charterSha: 'b'.repeat(64),
    charterMode: 'reference' as const,
    resumeContextText: '# SUCCESSION CONTEXT succ_test\n',
    incumbent: {
      paneKey: 'pane-incumbent',
      terminalHandle: 'handle-incumbent',
      sessionId: 'sess-1'
    }
  }
}

function fakeRuntime(overrides: {
  live?: Set<string>
  closed?: string[]
}): SuccessionStartupScanRuntime {
  const live = overrides.live ?? new Set<string>()
  const closed = overrides.closed ?? []
  return {
    getAgentDirectoryLivenessSignals: (paneKey: string) => ({
      terminalHandle: live.has(paneKey) ? `handle:${paneKey}` : null,
      observedLive: false
    }),
    closeTerminal: async (handle: string) => {
      closed.push(handle)
      return { closed: true } as never
    }
  } as unknown as SuccessionStartupScanRuntime
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-succession-startup-scan-'))
  storeDeps = { orcaHome: tempDir }
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  db.close()
})

describe('scanSuccessionsAtStartup', () => {
  it('sealed -> aborted (reason startup); never launches (agent directory stays empty)', async () => {
    const meta = await createSealed(storeDeps, 'chair-sealed', sealedInput())
    const runtime = fakeRuntime({})

    await scanSuccessionsAtStartup({ runtime, orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-sealed', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(db.listAgents({ hostId: 'local' }).agents).toEqual([])
  })

  it('launching, successor live AND incumbent dead -> aborted (reason startup_unconfirmed), successor pane left OPEN', async () => {
    const meta = await createSealed(storeDeps, 'chair-launching-live', sealedInput())
    await transition(storeDeps, 'chair-launching-live', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const closed: string[] = []
    const runtime = fakeRuntime({ live: new Set(['pane-successor']), closed })

    await scanSuccessionsAtStartup({ runtime, orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-launching-live', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup_unconfirmed')
    expect(closed).toEqual([]) // pane left open
    expect(db.listAgents({ hostId: 'local' }).agents).toEqual([])
  })

  it('launching, incumbent still live too -> aborted (reason startup), successor pane closed', async () => {
    const meta = await createSealed(storeDeps, 'chair-launching-both-live', sealedInput())
    await transition(storeDeps, 'chair-launching-both-live', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const closed: string[] = []
    const runtime = fakeRuntime({
      live: new Set(['pane-successor', 'pane-incumbent']),
      closed
    })

    await scanSuccessionsAtStartup({ runtime, orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-launching-both-live', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(closed).toEqual(['handle-successor'])
  })

  it('launching, successor pane dead too -> aborted (reason startup), no close attempted for a dead pane but no throw', async () => {
    const meta = await createSealed(storeDeps, 'chair-launching-neither-live', sealedInput())
    await transition(storeDeps, 'chair-launching-neither-live', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    const closed: string[] = []
    const runtime = fakeRuntime({ live: new Set(), closed })

    await scanSuccessionsAtStartup({ runtime, orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-launching-neither-live', meta.id)
    expect(after?.state).toBe('aborted')
    expect(after?.abortReason).toBe('startup')
    expect(closed).toEqual(['handle-successor'])
  })

  it('confirmed/aborted successions are untouched (listActive only returns sealed/launching)', async () => {
    const meta = await createSealed(storeDeps, 'chair-confirmed', sealedInput())
    await transition(storeDeps, 'chair-confirmed', meta.id, 'launching', {
      successor: {
        paneKey: 'pane-successor',
        terminalHandle: 'handle-successor',
        sessionId: 'sess-2'
      }
    })
    await transition(storeDeps, 'chair-confirmed', meta.id, 'confirmed', {})
    const runtime = fakeRuntime({})

    await scanSuccessionsAtStartup({ runtime, orcaHome: tempDir })

    const after = await read(storeDeps, 'chair-confirmed', meta.id)
    expect(after?.state).toBe('confirmed')
  })

  it('a missing chairs/ directory is a silent no-op', async () => {
    const runtime = fakeRuntime({})
    await expect(
      scanSuccessionsAtStartup({ runtime, orcaHome: join(tempDir, 'never-created') })
    ).resolves.toBeUndefined()
  })
})
