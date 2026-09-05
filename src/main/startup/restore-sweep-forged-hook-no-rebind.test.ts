/**
 * [S10-21a C12b, D-R125] Attacker fence T3b — S-C. A forged hook report for pane B (S-A's
 * fixture) coexists with an UNRELATED sweep restore for agent U whose `ensureAgentSession` lands
 * the fresh terminal on pane B — the worst case: the create lands on the attacker's pane. Real
 * `db`, real `rebindRestoredPane`, real predicate; doubles only for `deps` (the shared
 * restore-sweep fixtures). GREEN at base — pins pre-existing isolation, not the C12b fix.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import { restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { AgentHookServer } from '../agent-hooks/server'
import { raiseSessionIdentityMismatchAlarms } from './session-identity-mismatch-alarm'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  HOST_ID,
  EXEC_HOST_ID,
  LAUNCH_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEAF_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_A = makePaneKey('tab-a', LEAF_A)
const PANE_U = makePaneKey('tab-u', LEAF_U)
const PANE_B = makePaneKey('tab-b', LEAF_B)
const SID_A = 'sess-a'
const SID_U = 'sess-u'
const TOKEN_B = 'pane-b-real-launch-token'
const TOKEN_B_HASH = createHash('sha256').update(TOKEN_B).digest('hex')

describe('S10-21a C12b, D-R125 S-C: T3b — an unrelated sweep restore landing on the attacker pane never touches agent A', () => {
  let orchestrationDb: OrchestrationDb | undefined
  let server: AgentHookServer | undefined

  afterEach(() => {
    orchestrationDb?.close()
    server?.stop()
  })

  function rawDb(): Database.Database {
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it("agent A's row is untouched, no 'reminted' audit names A, and the outcome is a rebind of U or a typed refusal — never A", async () => {
    orchestrationDb = new OrchestrationDb(':memory:')
    const db = rawDb()
    insertAgent(db, { id: 'agent-A', display_name: 'agent-A', pane_key: PANE_A })
    insertAgent(db, { id: 'agent-U', display_name: 'agent-U', pane_key: PANE_U })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: PANE_A,
      agentType: 'claude',
      sessionId: SID_A,
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const uLaunch = recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: PANE_U,
      agentType: 'claude',
      sessionId: SID_U,
      launchGeneration: LAUNCH_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    if (!uLaunch.ok) {
      throw new Error('seed failed')
    }

    // Step 2: S-A's forged hook POST for pane B — an unrelated attacker interaction that must
    // not leak into the sweep's own bookkeeping for A or U.
    server = new AgentHookServer()
    server.setPaneLaunchAuthorityVerifier(
      (paneKey, launchTokenHash) => paneKey === PANE_B && launchTokenHash === TOKEN_B_HASH
    )
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: PANE_B,
        tabId: 'tab-b',
        worktreeId: 'wt-1',
        env: 'production',
        launchToken: TOKEN_B,
        payload: { hook_event_name: 'SessionStart', source: 'fork', session_id: SID_A }
      })
    })
    expect(response.status).toBe(204)
    raiseSessionIdentityMismatchAlarms(
      {
        hostId: HOST_ID,
        launchGeneration: LAUNCH_GEN,
        evaluateLiveHookReportMismatch: (params) =>
          orchestrationDb!.evaluateLiveHookReportMismatch(params),
        writeHostNoticeToPane: vi.fn()
      },
      server.getProviderSessionIdentities()
    )

    // Step 3: restore agent U — the worst case: `ensureAgentSession` lands the fresh terminal on
    // the ATTACKER's pane, B.
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: { paneKey: PANE_B, handle: 'h-b', executionHostId: 'local' },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb, { ensureAgentSession }),
      orchestrationDb,
      HOST_ID,
      'agent-U',
      null,
      'wt-1',
      uLaunch.row,
      emptyInventory()
    )

    // (i) agent A's row is completely untouched.
    const rowA = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-A') as {
      pane_key: string
      terminal_handle: string | null
      process_incarnation: string | null
    }
    expect(rowA.pane_key).toBe(PANE_A)
    expect(rowA.terminal_handle).toBeNull()
    expect(rowA.process_incarnation).toBeNull()

    // (ii) no 'reminted' rebind audit row names agent-A.
    const remintedForA = db
      .prepare(
        `SELECT 1 FROM agent_audit WHERE verb = 'rebind' AND outcome = 'reminted' AND agent_id = ?`
      )
      .get('agent-A')
    expect(remintedForA).toBeUndefined()

    // (iii) the outcome is a rebind of U, or a typed refusal — never a rebind claiming agent-A.
    if (outcome.kind === 'layer2' || outcome.kind === 'layer1') {
      const result = outcome.result as { rebound: boolean; agentId: string }
      expect(result.agentId).toBe('agent-U')
    } else {
      expect(outcome.kind).toBe('layer3')
      const reasonCode = (outcome as { reasonCode: string }).reasonCode
      expect(reasonCode).toMatch(/target_leaf_occupied|predecessor_moved/)
    }
    expect(
      outcome.kind === 'layer2' && (outcome.result as { agentId: string }).agentId === 'agent-A'
    ).toBe(false)

    // (iv) A's launch row is unchanged.
    expect(orchestrationDb.newestLaunchForPane(HOST_ID, PANE_A)?.session_id).toBe(SID_A)

    // (v) no sweep-restore mark was ever written for PANE_A (only U's own pane, if any, could be).
    expect(orchestrationDb.getSweepRestoreMark(HOST_ID, PANE_A)).toBe(false)
  })
})
