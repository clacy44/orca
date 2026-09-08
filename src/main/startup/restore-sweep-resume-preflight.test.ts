// S10-21c B2 (design §2 S4, chair synthesis S4): "never resume an empty transcript" — the
// restore sweep must preflight the reported session id through `deps.resolveResumeTranscript`
// (a thin wrapper over `session-file-resolver.ts#resolveSessionFilePath`, see
// resolve-resume-transcript.ts) BEFORE `mintRestoreTicket`/`ensureAgentSession`. A miss (null)
// or `hasTurn === false` (the file exists but carries only the `bridge-session` stub Claude
// Code writes for `--session-id X` before any turn) refuses at Layer 3
// (`sweep_resume_target_absent: <sessionId>`) — no ticket minted, no spawn. A real transcript
// (`hasTurn === true`) proceeds unchanged. A resolver throw is caught by the sweep's existing
// per-candidate try/catch (`runRestoreSweepBody`'s own `try { ... } catch (err) { ... }` around
// `restoreOneRegisteredPane`, restore-registered-agent-panes.ts:328-352) and must not abort the
// sweep for other panes — this file's own resolver-throw test proves that with TWO candidates.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../sqlite/sync-database'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { recordLaunch } from '../runtime/orchestration/agent-launch-sessions'
import type {
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../shared/agent-session-host-authority'
import type { ExecutionHostId } from '../../shared/execution-host'
import { runRestoreSweepBody, restoreOneRegisteredPane } from './restore-registered-agent-panes'
import { _resetRestoreSweepLockForTest } from '../runtime/restore-sweep-lock'
import {
  HOST_ID,
  EXEC_HOST_ID,
  PRIOR_GEN,
  emptyInventory,
  insertAgent,
  baseDeps
} from './restore-sweep-test-fixtures'

describe('S10-21c B2/S4: resume preflight (restoreOneRegisteredPane)', () => {
  let orchestrationDb: OrchestrationDb | undefined

  afterEach(() => {
    orchestrationDb?.close()
    _resetRestoreSweepLockForTest()
  })

  function rawDb(): Database.Database {
    orchestrationDb = new OrchestrationDb(':memory:')
    return (orchestrationDb as unknown as { db: Database.Database }).db
  }

  it('a stub-only transcript (hasTurn=false) refuses at Layer 3 before any ticket is minted', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-0000000000f4'
    insertAgent(db, { id: 'agent-f4', display_name: 'chair-f4', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'stub-sess-f4',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn()
    const mintRestoreTicket = vi.fn((payload: unknown) => JSON.stringify(payload) as never)
    // [D-R145 medium 6] Asserted below so the notice call cannot silently rot — it is
    // best-effort in the field (inert on a pane with nothing live), but the SWEEP must still
    // issue it every time this refusal fires.
    const writeHostNoticeToPane = vi.fn()
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        mintRestoreTicket,
        writeHostNoticeToPane,
        getTerminalProcessIncarnation: () => 'pty-f4:inc-f4',
        resolveResumeTranscript: async () => ({ path: '/does/not/matter', hasTurn: false })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-f4',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    expect((outcome as { reasonCode: string }).reasonCode).toContain('sweep_resume_target_absent')
    expect((outcome as { reasonCode: string }).reasonCode).toContain('stub-sess-f4')
    expect(mintRestoreTicket).not.toHaveBeenCalled()
    expect(ensureAgentSession).not.toHaveBeenCalled()
    expect(writeHostNoticeToPane).toHaveBeenCalledWith(
      predPaneKey,
      expect.any(String),
      expect.objectContaining({ rateKey: 'sweep_resume_target_absent' })
    )
    const auditRow = db.prepare(`SELECT * FROM agent_audit ORDER BY seq DESC LIMIT 1`).get() as {
      verb: string
      reason_code: string
    }
    expect(auditRow.verb).toBe('sweep_layer3')
    expect(auditRow.reason_code).toContain('sweep_resume_target_absent')
  })

  it('a miss (resolver returns null) refuses at Layer 3 the same way as a stub', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-0000000000f5'
    insertAgent(db, { id: 'agent-f5', display_name: 'chair-f5', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'missing-sess-f5',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const mintRestoreTicket = vi.fn((payload: unknown) => JSON.stringify(payload) as never)
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        mintRestoreTicket,
        getTerminalProcessIncarnation: () => 'pty-f5:inc-f5',
        resolveResumeTranscript: async () => null
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-f5',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer3')
    expect((outcome as { reasonCode: string }).reasonCode).toContain('sweep_resume_target_absent')
    expect(mintRestoreTicket).not.toHaveBeenCalled()
  })

  it('a transcript with turns (hasTurn=true) proceeds unchanged (Layer 1/2, ticket minted)', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-0000000000f6'
    insertAgent(db, { id: 'agent-f6', display_name: 'chair-f6', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'real-sess-f6',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-f6',
        paneKey: predPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const resolveResumeTranscript = vi.fn(async () => ({
      path: '/real/sess-f6.jsonl',
      hasTurn: true
    }))
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty-f6:inc-f6',
        resolveResumeTranscript
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-f6',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(resolveResumeTranscript).toHaveBeenCalledWith('claude', 'real-sess-f6')
    expect(ensureAgentSession).toHaveBeenCalled()
  })

  it('[D-R145 low 9] an agent type the resolver does not cover -> proceeds (never Layer-3), audit note only', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-0000000000fa'
    insertAgent(db, { id: 'agent-fa', display_name: 'chair-fa', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'gemini',
      sessionId: 'sess-fa',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn().mockResolvedValue({
      terminal: {
        handle: 'handle-fa',
        paneKey: predPaneKey,
        worktreeId: 'wt-1',
        title: null,
        executionHostId: EXEC_HOST_ID
      },
      disposition: 'created'
    })
    const outcome = await restoreOneRegisteredPane(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty-fa:inc-fa',
        resolveResumeTranscript: async () => ({ coverage: 'uncovered' })
      }),
      orchestrationDb!,
      HOST_ID,
      'agent-fa',
      null,
      'wt-1',
      orchestrationDb!.newestLaunchForPane(HOST_ID, predPaneKey)!,
      emptyInventory()
    )
    expect(outcome.kind).toBe('layer1')
    expect(ensureAgentSession).toHaveBeenCalled()
    const noteRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'resume_preflight_uncovered%'`)
      .all() as { verb: string; outcome: string; reason_code: string }[]
    expect(noteRows).toHaveLength(1)
    expect(noteRows[0]!.verb).toBe('sweep_note')
    expect(noteRows[0]!.reason_code).toBe('resume_preflight_uncovered gemini')
  })

  it('a resolver throw is Layer-3 for that pane only; a second candidate still restores', async () => {
    const db = rawDb()
    const throwingPane = 'tab1:00000000-0000-4000-8000-0000000000f7'
    const okPane = 'tab2:00000000-0000-4000-8000-0000000000f8'
    insertAgent(db, { id: 'agent-f7', display_name: 'chair-f7', pane_key: throwingPane })
    insertAgent(db, { id: 'agent-f8', display_name: 'chair-f8', pane_key: okPane })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: throwingPane,
      agentType: 'claude',
      sessionId: 'sess-f7',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: okPane,
      agentType: 'claude',
      sessionId: 'sess-f8',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const ensureAgentSession = vi.fn(
      async (
        request: RuntimeEnsureAgentSessionRequest
      ): Promise<RuntimeEnsureAgentSessionResult> => {
        if (request.kind === 'explicit' && request.providerSession.id === 'sess-f7') {
          throw new Error('unreachable: resolver should refuse before ensureAgentSession')
        }
        return {
          terminal: {
            handle: 'handle-f8',
            paneKey: okPane,
            worktreeId: 'wt-1',
            title: null,
            executionHostId: EXEC_HOST_ID as ExecutionHostId
          },
          disposition: 'created'
        }
      }
    )
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        ensureAgentSession,
        getTerminalProcessIncarnation: () => 'pty:inc',
        resolveResumeTranscript: async (_agentType: string, sessionId: string) => {
          if (sessionId === 'sess-f7') {
            throw new Error('resolver_boom')
          }
          return { path: '/real/sess-f8.jsonl', hasTurn: true }
        }
      })
    )
    // A throw out of restoreOneRegisteredPane (never caught inside it — resolveResumeTranscript
    // is called with no inner try/catch) is caught by runRestoreSweepBody's own per-candidate
    // try/catch, which bumps `errors` (not `layer3`) but still writes a `sweep_layer3`-verb
    // audit row (auditLayer3) — the pre-existing generic safety net, unmodified by S4.
    expect(summary.errors).toBe(1)
    expect(summary.layer1 + summary.layer2).toBe(1)
    expect(summary.layer3).toBe(0)
    const threwAudit = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'sweep_row_threw:%resolver_boom%'`)
      .all()
    expect(threwAudit).toHaveLength(1)
  })

  it('[D-R148 low 7] a throwing writeHostNoticeToPane on the S4 refusal still returns Layer-3 with sweep_resume_target_absent, degrading the notice to a note', async () => {
    const db = rawDb()
    const predPaneKey = 'tab1:00000000-0000-4000-8000-0000000000f9'
    insertAgent(db, { id: 'agent-f9', display_name: 'chair-f9', pane_key: predPaneKey })
    recordLaunch(db, {
      hostId: HOST_ID,
      paneKey: predPaneKey,
      agentType: 'claude',
      sessionId: 'stub-sess-f9',
      launchGeneration: PRIOR_GEN,
      executionHostId: EXEC_HOST_ID,
      evidence: 'host_launch'
    })
    const summary = await runRestoreSweepBody(
      baseDeps(orchestrationDb!, {
        getTerminalProcessIncarnation: () => 'pty-f9:inc-f9',
        resolveResumeTranscript: async () => ({ path: '/does/not/matter', hasTurn: false }),
        writeHostNoticeToPane: () => {
          throw new Error('pane_notice_boom_f9')
        }
      })
    )
    // The throw is now contained at its own call site — it must never escape as a
    // `sweep_row_threw` (the pre-D-R148 shape), which would lose the coded
    // `sweep_resume_target_absent` deferral family and report a harness-shaped error instead.
    expect(summary.errors).toBe(0)
    expect(summary.layer3).toBe(1)
    expect(summary.deferredByReason['sweep_resume_target_absent: session']).toBe(1)
    const refusalRow = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'sweep_resume_target_absent:%'`)
      .all()
    expect(refusalRow).toHaveLength(1)
    const noticeFailedRows = db
      .prepare(
        `SELECT * FROM agent_audit WHERE reason_code LIKE 'notice_failed:%pane_notice_boom_f9%'`
      )
      .all()
    expect(noticeFailedRows).toHaveLength(1)
    const threwRows = db
      .prepare(`SELECT * FROM agent_audit WHERE reason_code LIKE 'sweep_row_threw:%'`)
      .all()
    expect(threwRows).toHaveLength(0)
  })
})
