/**
 * [S10-21a C12b, D-R125] Attacker fences T3/T3b/T20 (behavioural half) — S-A/S-B. Real
 * `AgentHookServer` (real HTTP POST to `/hook/claude`), real in-memory `OrchestrationDb`, real
 * evaluator (`evaluateLiveHookReportMismatch`) driven exactly as `session-identity-mismatch-alarm.ts`
 * wires it. The ONLY double is `writeHostNoticeToPane`. Do not stub `isCorroboratedAuthority`,
 * the evaluator, or `current_sessions` — they are the fence under test. All scenarios here are
 * GREEN at base (they pin pre-existing fence behaviour, not the C12b fix itself).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { AgentHookServer } from './server'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { raiseSessionIdentityMismatchAlarms } from '../startup/session-identity-mismatch-alarm'
import { makePaneKey } from '../../shared/stable-pane-id'

const LEAF_A = '11111111-1111-4111-8111-1111111111aa'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const TAB_A = 'tab-a'
const TAB_B = 'tab-b'
const PANE_A = makePaneKey(TAB_A, LEAF_A)
const PANE_B = makePaneKey(TAB_B, LEAF_B)
const HOST = 'local'
const GEN = 'gen-1'
const SID_A = 'sess-a-original'
const SID_B = 'sess-b-original'
const TOKEN_B = 'pane-b-real-launch-token'
const TOKEN_B_HASH = createHash('sha256').update(TOKEN_B).digest('hex')

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function auditRows(db: OrchestrationDb, paneKey: string) {
  return rawDb(db)
    .prepare(
      `SELECT agent_id, actor_pane_key, verb, outcome, reason_code FROM agent_audit
         WHERE actor_pane_key = ? AND verb = 'session_identity_mismatch'`
    )
    .all(paneKey) as {
    agent_id: string | null
    actor_pane_key: string
    verb: string
    outcome: string
    reason_code: string | null
  }[]
}

function currentSessionPane(db: OrchestrationDb, sessionId: string) {
  return rawDb(db)
    .prepare('SELECT pane_key FROM current_sessions WHERE host_id = ? AND session_id = ?')
    .get(HOST, sessionId) as { pane_key: string } | undefined
}

describe('S10-21a C12b, D-R125 S-A/S-B: forged hook report, valid OWN anchor — the launch row and current_sessions never move', () => {
  let server: AgentHookServer | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    server?.stop()
    db?.close()
  })

  function seedFixture() {
    server = new AgentHookServer()
    // The verifier corroborates ONLY pane B holding ITS OWN real launch token — never pane A.
    server.setPaneLaunchAuthorityVerifier(
      (paneKey, launchTokenHash) => paneKey === PANE_B && launchTokenHash === TOKEN_B_HASH
    )
    db = new OrchestrationDb(':memory:')
    const seededA = db.recordLaunch({
      hostId: HOST,
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: SID_A,
      launchGeneration: GEN,
      executionHostId: HOST,
      evidence: 'host_launch'
    })
    const seededB = db.recordLaunch({
      hostId: HOST,
      paneKey: PANE_B,
      agentType: 'claude',
      sessionId: SID_B,
      launchGeneration: GEN,
      executionHostId: HOST,
      evidence: 'host_launch'
    })
    if (!seededA.ok || !seededB.ok) {
      throw new Error('seed failed')
    }
    return { seededA: seededA.row, seededB: seededB.row }
  }

  async function postForgedHook(paneKey: string, tabId: string): Promise<Response> {
    const env = server!.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey,
        tabId,
        worktreeId: 'wt-1',
        env: 'production',
        launchToken: TOKEN_B,
        payload: { hook_event_name: 'SessionStart', source: 'fork', session_id: SID_A }
      })
    })
  }

  async function driveAlarmsAndAssertUnchanged(seededA: unknown, seededB: unknown) {
    const notice = vi.fn()
    const identities = server!.getProviderSessionIdentities()
    raiseSessionIdentityMismatchAlarms(
      {
        hostId: HOST,
        launchGeneration: GEN,
        evaluateLiveHookReportMismatch: (params) => db!.evaluateLiveHookReportMismatch(params),
        writeHostNoticeToPane: notice
      },
      identities
    )

    // (i) the channel accepted the forged claim (T20): B's identity carries SID_A, corroborated.
    expect(identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paneKey: PANE_B,
          sessionId: SID_A,
          anchorCorroborated: true,
          sessionStartSource: 'fork'
        })
      ])
    )
    // (ii) B's own newest row is UNCHANGED — the successor SID_A collides with A's current_sessions
    // row (UNIQUE(host_id, session_id)), so recordSelfReportRotation refuses; never rewritten.
    const newestB = db!.newestLaunchForPane(HOST, PANE_B)
    expect(newestB?.session_id).toBe(SID_B)
    expect(newestB?.evidence).not.toBe('self_report_rotation')
    // (iii) A's row is untouched, byte-identical to the seeded row.
    expect(db!.newestLaunchForPane(HOST, PANE_A)).toEqual(seededA)
    expect(db!.newestLaunchForPane(HOST, PANE_B)).toEqual(seededB)
    // (iv) current_sessions still maps SID_A -> PANE_A.
    expect(currentSessionPane(db!, SID_A)?.pane_key).toBe(PANE_A)
    // (v) exactly one contested audit row, attributed to PANE_B (the row this report actually
    // resolves to — not a forged-key case, so no F2 branch fires here).
    const rows = auditRows(db!, PANE_B)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      outcome: 'contested',
      reason_code: `recorded=${SID_B} reported=${SID_A}`
    })
    // (vi) the notice spy fired for PANE_B only.
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice.mock.calls[0][0]).toBe(PANE_B)
    // (vii) zero rows anywhere carry A's agent_id on PANE_B (agent_id is null here — no
    // registered `agents` row was seeded — so this reduces to: no audit row on PANE_B names A).
    expect(auditRows(db!, PANE_B).every((r) => r.agent_id === null)).toBe(true)
  }

  it("S-A: forged hook report for pane B claiming A's session id — accepted on the wire, refused at the lineage fence", async () => {
    const { seededA, seededB } = seedFixture()
    await server!.start({ env: 'production' })
    const response = await postForgedHook(PANE_B, TAB_B)
    expect(response.status).toBe(204)

    await driveAlarmsAndAssertUnchanged(seededA, seededB)
  })

  it('S-A variant: a forged pane key (real leaf suffix, forged tab prefix) never corroborates — anchorCorroborated is false, the row it resolves to is unchanged', async () => {
    seedFixture()
    await server!.start({ env: 'production' })
    const forgedPaneKey = `forged-tab:${LEAF_A}`
    const response = await postForgedHook(forgedPaneKey, 'forged-tab')
    expect(response.status).toBe(204)

    const identities = server!.getProviderSessionIdentities()
    expect(identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paneKey: forgedPaneKey,
          sessionId: SID_A,
          anchorCorroborated: false
        })
      ])
    )
    // The forged claim never touches A's own row.
    expect(db!.newestLaunchForPane(HOST, PANE_A)?.session_id).toBe(SID_A)
  })

  it('S-B: same fence after a daemon death — current_sessions row for SID_A survives, proving the daemon-death path never deletes it', async () => {
    const { seededA, seededB } = seedFixture()
    db!.writeAgentAudit({
      agentId: null,
      actorPaneKey: PANE_A,
      actorHostId: HOST,
      verb: 'daemon_died',
      outcome: 'observed',
      reasonCode: null
    })
    await server!.start({ env: 'production' })
    const response = await postForgedHook(PANE_B, TAB_B)
    expect(response.status).toBe(204)

    await driveAlarmsAndAssertUnchanged(seededA, seededB)
    // current_sessions row for SID_A is still present post-daemon-death.
    expect(currentSessionPane(db!, SID_A)).toBeDefined()
  })
})
