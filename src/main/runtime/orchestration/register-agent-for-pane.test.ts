// S10-21d b3 (DEC-6): registerAgentForPane — the in-process extraction of
// orchestration.agents.register's own write, called directly (no RPC context, no caller
// authority round-trip) the way `requestChairRestore` calls it.
import { describe, expect, it, vi } from 'vitest'
import { registerAgentForPane } from './register-agent-for-pane'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { DIRECTORY_LIVE_CAP } from '../rpc/methods/agent-directory-rpc-view'
import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_a',
    ptyId: 'pty-a',
    worktreeId: 'wt_1',
    worktreePath: '/repo/alpha',
    branch: 'alpha',
    tabId: 'tabA',
    leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: 'alpha work',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

function setup(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [terminal()],
    totalCount: 1,
    truncated: false
  })
  vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockReturnValue({
    terminalHandle: 'term_a',
    lastAgentStatus: null,
    observedLive: true
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return { db, runtime }
}

describe('S10-21d b3: registerAgentForPane', () => {
  it('creates a fresh row for a pane with no existing registration', async () => {
    const { db, runtime } = setup()
    const outcome = await registerAgentForPane(db, runtime, {
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      displayName: 'backend-dll',
      role: 'backend server DLL plugin'
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.created).toBe(true)
      expect(outcome.agent.display_name).toBe('backend-dll')
      expect(outcome.agent.role).toBe('backend server DLL plugin')
    }
    expect(db.getAgentByPaneKey('local', PANE_A)?.display_name).toBe('backend-dll')
  })

  it('refuses an invalid name without writing a row', async () => {
    const { db, runtime } = setup()
    const outcome = await registerAgentForPane(db, runtime, {
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      displayName: 'Not Valid',
      role: undefined
    })
    expect(outcome).toEqual({ ok: false, reason: 'invalid_name', reasonCode: 'invalid_charset' })
    expect(db.getAgentByPaneKey('local', PANE_A)).toBeUndefined()
  })

  it('refuses name_taken when a different LIVE pane already holds the name', async () => {
    const { db, runtime } = setup()
    await registerAgentForPane(db, runtime, {
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      displayName: 'frontend-stack',
      role: undefined
    })
    const outcome = await registerAgentForPane(db, runtime, {
      paneKey: PANE_B,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-2',
      displayName: 'frontend-stack',
      role: undefined
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('name_taken')
    }
  })

  it('re-registering the SAME pane re-mints its own row, not a name_taken refusal', async () => {
    const { db, runtime } = setup()
    await registerAgentForPane(db, runtime, {
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      displayName: 'player-overlay',
      role: 'r1'
    })
    const outcome = await registerAgentForPane(db, runtime, {
      paneKey: PANE_A,
      terminalHandle: 'term_a',
      processIncarnation: 'proc-1',
      displayName: 'player-overlay',
      role: 'r2'
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.reMinted).toBe(true)
      expect(outcome.agent.role).toBe('r2')
    }
  })

  // [G1-10z polish-recheck N1 regression] a derived name holder is not a same-name dead-pane
  // takeover (its re-point re-mints `derived = 0`, raising the cap-counted total) — it must be
  // refused at the cap like any other new registration (probe P1 A shape).
  it('refuses directory_full for a new pane taking a DERIVED name holder at the cap', async () => {
    const { db, runtime } = setup()
    const derivedPaneKey = 'tabD:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    // [G1-10z R2-L1] the derived holder's own pane must be DEAD, or isSameNameDeadPaneTakeover
    // never reaches the derived check (it short-circuits on holderPaneIsLive first) — this test
    // would then pass whether or not the derived exemption exists.
    vi.spyOn(runtime, 'getAgentDirectoryLivenessSignals').mockImplementation((paneKey: string) =>
      paneKey === derivedPaneKey
        ? { terminalHandle: null, lastAgentStatus: null, observedLive: false }
        : { terminalHandle: 'term_a', lastAgentStatus: null, observedLive: true }
    )
    for (let i = 0; i < DIRECTORY_LIVE_CAP; i += 1) {
      const leaf = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      const result = db.upsertAgentByPaneSuffix({
        displayName: `filler-${i}`,
        role: null,
        hostId: 'local',
        paneKey: `tabF${i}:${leaf}`,
        terminalHandle: `term_f${i}`,
        processIncarnation: null,
        worktreeId: null,
        worktreePath: null,
        branch: null,
        title: null,
        agentLabel: null,
        originHandle: `term_f${i}`,
        originHostId: 'local',
        isPaneLive: () => false
      })
      if (result.outcome === 'name_taken') {
        throw new Error('fixture: unexpected name_taken while filling the directory')
      }
    }
    const derived = db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: derivedPaneKey,
      terminalHandle: 'term_d',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: '/w/derived-repo',
      branch: 'feat-derived',
      title: null,
      agentLabel: null
    })
    expect(derived?.derived).toBe(1)

    const outcome = await registerAgentForPane(db, runtime, {
      paneKey: 'tabN:99999999-0000-4000-8000-000000000000',
      terminalHandle: 'term_new',
      processIncarnation: null,
      displayName: derived!.display_name,
      role: undefined
    })

    expect(outcome).toMatchObject({ ok: false, reason: 'directory_full' })
  })
})
