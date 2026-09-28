// INV-P-023: agent-launch-admission.ts's own host-integrity chokepoint call. Same harness as
// agent-launch-admission.test.ts (real in-memory OrchestrationDb, ctx()/opts() shapes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { admitAgentLaunch, type LaunchAdmission } from './agent-launch-admission'
import { HostElevatedRefusedError } from './agent-launch-admission-errors'
import { ADMISSION_AUDIT_VERBS } from './agent-launch-admission-support'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../shared/setup-agent-sequencing'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'
import {
  configureHostIntegrityForTests,
  resetHostIntegrityForTests
} from '../host-integrity/host-integrity-guard'
import type { IntegrityProbe } from '../host-integrity/windows-integrity-level'
import type { DaemonIntegrityReport } from '../../shared/host-integrity-types'

const CALLER: LaunchAdmission = { kind: 'caller' }
const HOST_ID = 'local'

function probeOf(level: IntegrityProbe['level']): () => Promise<IntegrityProbe> {
  return async () => ({ level, detail: 'test' })
}

describe('INV-P-023: admitAgentLaunch host-integrity chokepoint', () => {
  let orchestrationDb: OrchestrationDb | undefined

  beforeEach(() => {
    resetHostIntegrityForTests()
  })

  afterEach(() => {
    resetHostIntegrityForTests()
    orchestrationDb?.close()
    orchestrationDb = undefined
  })

  function freshDb(): OrchestrationDb {
    orchestrationDb = new OrchestrationDb(':memory:')
    return orchestrationDb
  }

  function rawDb(db: OrchestrationDb): Database.Database {
    return (db as unknown as { db: Database.Database }).db
  }

  function hostIntegrityRows(
    db: OrchestrationDb
  ): { outcome: string; actor_pane_key: string | null }[] {
    return rawDb(db)
      .prepare("SELECT outcome, actor_pane_key FROM agent_audit WHERE verb = 'host_integrity'")
      .all() as { outcome: string; actor_pane_key: string | null }[]
  }

  function ctx(overrides: Partial<Parameters<typeof admitAgentLaunch>[3]> = {}) {
    return {
      hostId: HOST_ID,
      executionHostId: HOST_ID,
      launchGeneration: 'gen-1',
      notice: () => {},
      contestedLineage: () => {},
      findConnectedPtyForPane: () => false,
      callerResume: null,
      ...overrides
    }
  }

  function opts(overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions {
    return { cols: 80, rows: 24, launchAgent: 'claude', paneKey: 'tab1:leaf-a', ...overrides }
  }

  describe('high host', () => {
    beforeEach(() => {
      configureHostIntegrityForTests({ probe: probeOf('high') })
    })

    it('refuses a covered launch, writes no launch row, writes one refused row', async () => {
      const db = freshDb()
      await expect(
        admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
      ).rejects.toThrow(HostElevatedRefusedError)
      expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeUndefined()
      const rows = hostIntegrityRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ outcome: 'refused', actor_pane_key: 'tab1:leaf-a' })
    })

    it('refuses a covered launch of a non-claude agent', async () => {
      const db = freshDb()
      await expect(
        admitAgentLaunch(() => db, opts({ launchAgent: 'codex', command: 'codex' }), CALLER, ctx())
      ).rejects.toThrow(HostElevatedRefusedError)
    })

    it('refuses a sniffed launch (claude on the startup line)', async () => {
      const db = freshDb()
      await expect(
        admitAgentLaunch(
          () => db,
          opts({ launchAgent: undefined, command: 'claude --model opus' }),
          CALLER,
          ctx()
        )
      ).rejects.toThrow(HostElevatedRefusedError)
    })

    it('N6: a spawn whose sequenced startup line runs claude is refused on a high host', async () => {
      const db = freshDb()
      await expect(
        admitAgentLaunch(
          () => db,
          opts({
            launchAgent: undefined,
            command: undefined,
            env: { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: 'claude --model opus' }
          }),
          CALLER,
          ctx()
        )
      ).rejects.toThrow(HostElevatedRefusedError)
    })

    it('a plain shell resolves and never touches the db', async () => {
      const getDb = vi.fn()
      const admitted = await admitAgentLaunch(
        getDb,
        opts({ launchAgent: undefined, command: undefined }),
        CALLER,
        ctx()
      )
      expect(admitted).toBeDefined()
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  it('high with override: admitted, launch row written, one allowed_by_override row', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high'), env: { ORCA_ALLOW_ELEVATED: '1' } })
    const db = freshDb()
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(admitted.classification).toBe('host_minted')
    expect(db.newestLaunchForPane(HOST_ID, 'tab1:leaf-a')).toBeDefined()
    const rows = hostIntegrityRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('allowed_by_override')
  })

  it('medium host: host_minted unchanged, zero host_integrity rows', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium') })
    const db = freshDb()
    const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
    expect(admitted.classification).toBe('host_minted')
    expect(hostIntegrityRows(db)).toHaveLength(0)
  })

  describe('medium host with daemon high', () => {
    beforeEach(() => {
      configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => 'high' })
    })

    it('local ctx is refused with data.source === daemon', async () => {
      const db = freshDb()
      const rejection = admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
      await expect(rejection).rejects.toThrow(HostElevatedRefusedError)
      await rejection.catch((e) => {
        expect((e as HostElevatedRefusedError).data.source).toBe('daemon')
      })
    })

    it('a remote (ssh) ctx is admitted', async () => {
      const db = freshDb()
      const admitted = await admitAgentLaunch(
        () => db,
        opts({ command: 'claude', commandDelivery: 'provider' }),
        CALLER,
        ctx({ executionHostId: 'ssh:conn-1' })
      )
      expect(admitted.classification).toBe('host_minted')
    })
  })

  it.each<DaemonIntegrityReport>(['unreported', 'inherited'])(
    'daemon %s is admitted',
    async (daemon) => {
      configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => daemon })
      const db = freshDb()
      const admitted = await admitAgentLaunch(() => db, opts({ command: 'claude' }), CALLER, ctx())
      expect(admitted.classification).toBe('host_minted')
    }
  )

  it("ADMISSION_AUDIT_VERBS does not contain 'host_integrity'", () => {
    expect(ADMISSION_AUDIT_VERBS).not.toContain('host_integrity')
  })
})
