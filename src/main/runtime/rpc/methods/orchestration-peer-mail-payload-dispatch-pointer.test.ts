// F-9 item (c) (delta review, Ruling 32 Addendum 9): classifyRawPeerMailDestination
// (orchestration.ts) gates a peer-supplied to:/run:/dispatch: pointer, but resolveMessageRun
// ALSO derives a dispatchId from the peer-supplied `payload` JSON and calls
// db.getDispatchContextById on it unvalidated — a hostile payload dispatchId could reach that
// lookup, or have dispatch_run_mismatch echo a foreign dispatch's run id back on a correct
// guess. Split into its own file (not appended to orchestration.test.ts, which already carries
// per this repo's own split-file precedent for RPC method test coverage (e.g.
// orchestration-peer-mailbox-check.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import type Database from '../../../sqlite/sync-database'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

describe('resolveMessageRun payload-borne dispatchId grammar gate (F-9 item c)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    activeRunId = db.createRun({
      objective: 'Test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  afterEach(() => {
    db?.close()
  })

  it('refuses a hostile payload dispatchId from a peer before any lookup, one audit row, no echo', async () => {
    setup()
    ctx = {
      runtime,
      accessProfile: 'peer',
      authenticatedCallerFingerprint: 'fp_peer',
      pairedDeviceId: 'dev_peer',
      clientKind: 'runtime'
    }
    const hostile = "'; DROP TABLE messages;--"
    const getDispatchSpy = vi.spyOn(db, 'getDispatchContextById')

    let caught: { code?: string; message?: string } | undefined
    try {
      await call('orchestration.send', {
        to: `run:${activeRunId}`,
        run: activeRunId,
        subject: 'hi',
        body: 'body',
        payload: JSON.stringify({ dispatchId: hostile }),
        remoteRunMailbox: true
      })
    } catch (error) {
      caught = error as { code?: string; message?: string }
    }

    expect(caught?.code).toBe('invalid_argument')
    expect(caught?.message).not.toContain('DROP TABLE')
    expect(getDispatchSpy).not.toHaveBeenCalled()

    const rawDb = (db as unknown as { db: Database.Database }).db
    const auditRows = rawDb
      .prepare(
        "SELECT verb, outcome, reason_code, actor_host_id FROM agent_audit WHERE reason_code = 'malformed_relay_id'"
      )
      .all() as { verb: string; outcome: string; reason_code: string; actor_host_id: string }[]
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].outcome).toBe('invalid_argument')
  })

  it("a well-formed but nonexistent payload dispatchId from a peer keeps today's envelope (not refused by the grammar gate)", async () => {
    setup()
    ctx = {
      runtime,
      accessProfile: 'peer',
      authenticatedCallerFingerprint: 'fp_peer',
      pairedDeviceId: 'dev_peer',
      clientKind: 'runtime'
    }

    await expect(
      call('orchestration.send', {
        to: `run:${activeRunId}`,
        run: activeRunId,
        subject: 'hi',
        body: 'body',
        payload: JSON.stringify({ dispatchId: 'ctx_aaaaaaaaaaaa' }),
        remoteRunMailbox: true
      })
    ).resolves.not.toMatchObject({ code: 'invalid_argument' })
  })

  it("a local (non-peer) caller's own payload dispatchId is unaffected by the grammar gate", async () => {
    setup()
    const getDispatchSpy = vi.spyOn(db, 'getDispatchContextById')

    await expect(
      call('orchestration.send', {
        to: `run:${activeRunId}`,
        subject: 'hi',
        body: 'body',
        payload: JSON.stringify({ dispatchId: 'not-a-real-id' })
      })
    ).resolves.not.toMatchObject({ code: 'invalid_argument' })
    // A local caller reaches the ordinary lookup path (no grammar gate applied) — the
    // malformed payload dispatchId simply misses in the db, same as before this fix.
    expect(getDispatchSpy).toHaveBeenCalledWith('not-a-real-id')
  })
})
