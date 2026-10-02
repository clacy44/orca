// D-30a / Ruling 36 (train 10z.9, arm H): the sweep's chair verdict reads the host-scoped manifest
// once per sweep and fails closed, and the `internal` argument carries the flag only when armed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type { ChairsManifestEntry } from '../runtime/orchestration/chairs-manifest'
import type { RestoreTicketId } from '../runtime/restore-ticket-registry'
import { runRestoreSweep } from './restore-registered-agent-panes'
import { createIsManifestChairPane, hostRestoreInternal } from './restore-sweep-reanchor'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

const paneOf = (n: number): string => `tab1:00000000-0000-4000-8000-0000000d00${n}${n}`
const chairEntry = (n: number, extra: Partial<ChairsManifestEntry> = {}): ChairsManifestEntry => ({
  name: `chair-${n}`,
  worktree: '/repo/app',
  agent: 'claude',
  conversationId: `sess-${paneOf(n)}`,
  ...extra
})

describe('D-30a: createIsManifestChairPane and hostRestoreInternal', () => {
  let orchestrationDb: OrchestrationDb | undefined
  let home: string | undefined
  const realHome = process.env.HOME
  const realUserProfile = process.env.USERPROFILE

  beforeEach(() => {
    orchestrationDb = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
    process.env.HOME = realHome
    if (realUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = realUserProfile
    }
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = undefined
    }
  })

  function rawDb(): Database.Database {
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  function seed(n: number): string {
    const paneKey = paneOf(n)
    insertAgent(rawDb(), { id: `agent-${n}`, display_name: `chair-${n}`, pane_key: paneKey })
    recordLaunch(rawDb(), {
      hostId: HOST_ID,
      paneKey,
      agentType: 'claude',
      sessionId: `sess-${paneKey}`,
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    return paneKey
  }

  function isChair(readChairs: () => Promise<ChairsManifestEntry[] | null>) {
    return createIsManifestChairPane(
      () => orchestrationDb!,
      () => HOST_ID,
      readChairs
    )
  }

  it('answers true for a manifest chair lineage and false for any other pane', async () => {
    const chairPane = seed(1)
    const otherPane = seed(2)
    const check = isChair(async () => [chairEntry(1)])
    expect(await check(chairPane)).toBe(true)
    expect(await check(otherPane)).toBe(false)
    expect(await check('tab9:00000000-0000-4000-8000-000000000999')).toBe(false)
  })

  it('(c) a null or rejecting manifest read answers false', async () => {
    const pane = seed(1)
    expect(await isChair(async () => null)(pane)).toBe(false)
    expect(
      await isChair(async () => {
        throw new Error('unreadable')
      })(pane)
    ).toBe(false)
  })

  it('(i) N candidates read the manifest once', async () => {
    seed(1)
    seed(2)
    seed(3)
    const readChairs = vi.fn(async () => [chairEntry(1), chairEntry(3)])
    const ensureAgentSession = vi.fn().mockImplementation(async () => ({
      terminal: { handle: 'h', worktreeId: 'wt-1', title: null, executionHostId: EXEC_HOST_ID },
      disposition: 'created'
    }))
    await runRestoreSweep(
      baseDeps(orchestrationDb!, { ensureAgentSession, isManifestChairPane: isChair(readChairs) })
    )
    expect(ensureAgentSession).toHaveBeenCalledTimes(3)
    expect(readChairs).toHaveBeenCalledTimes(1)
    const flagged = ensureAgentSession.mock.calls
      .filter(([, , internal]) => 'hostReanchor' in (internal as object))
      .map(([request]) => (request as { providerSession: { id: string } }).providerSession.id)
    expect(flagged.sort()).toEqual([`sess-${paneOf(1)}`, `sess-${paneOf(3)}`])
  })

  it('(g) the real reader drops a manifest entry for another host, and a missing file is not a chair', async () => {
    const pane = seed(1)
    home = mkdtempSync(join(tmpdir(), 'orca-reanchor-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    const check = createIsManifestChairPane(
      () => orchestrationDb!,
      () => HOST_ID
    )
    expect(await check(pane)).toBe(false)

    mkdirSync(join(home, '.orca'), { recursive: true })
    const write = (chairs: ChairsManifestEntry[]): void =>
      writeFileSync(join(home!, '.orca', 'chairs.json'), JSON.stringify({ version: 1, chairs }))

    write([chairEntry(1, { host: `${hostname()}-not-this-host` })])
    expect(
      await createIsManifestChairPane(
        () => orchestrationDb!,
        () => HOST_ID
      )(pane)
    ).toBe(false)

    write([chairEntry(1, { host: hostname() })])
    expect(
      await createIsManifestChairPane(
        () => orchestrationDb!,
        () => HOST_ID
      )(pane)
    ).toBe(true)
  })

  it('hostRestoreInternal carries hostReanchor only when armed', () => {
    const ticket = 'ticket-1' as RestoreTicketId
    expect(hostRestoreInternal(ticket, false)).toEqual({
      restoreProvenance: { kind: 'host-restore', ticket }
    })
    expect(hostRestoreInternal(ticket, true)).toEqual({
      restoreProvenance: { kind: 'host-restore', ticket },
      hostReanchor: true
    })
  })
})
