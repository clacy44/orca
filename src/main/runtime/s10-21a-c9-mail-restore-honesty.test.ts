/**
 * S10-21a C9 (design v3.2 §5(1)-(2), Ruling 34 Addendum 5, N5 fix): mail-on-restore honesty.
 *
 * §5(1): `deliverPendingMessagesForHandle`'s pty (leafless) branch used to delete the withheld
 * record unconditionally in its final `else` — at a restore `observedLive` is false, so a real
 * delivery failure there read as plain `queued` with nothing armed to retry (the silent-delete
 * defect this commit fixes). It now records (`awaiting_idle_edge`) whenever the pane has not
 * been observed live this generation, and only deletes (stale-record cleanup) once it has.
 *
 * §5(2): a restore rebind (or a Layer-1 preserve) arms delivery via
 * `OrcaRuntimeService#notifyRebindDelivery` — `notifyMessageArrived` then
 * `deliverPendingMessagesForHandle`, both against `agent:<id>` — so mail already waiting on the
 * mailbox surfaces without the operator running `register` again.
 *
 * Harness: mirrors s10-15-leafless-delivery.test.ts's headless-pty idiom (real
 * OrcaRuntimeService + injected pty controller) for T16, and orchestration-agent-mailbox-idle-
 * push.test.ts's real in-memory OrchestrationDb idiom for the agent:<id>-mailbox half (T11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { AGENT_PROMPT_SUBMIT_DELAY_MS } from '../../shared/agent-prompt-injection'

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null; paneKey?: string | null }
  ) => unknown
  issuePtyHandle: (pty: unknown) => string
  withheldDeliveryAttemptsByHandle: Map<string, { at: number; reason: string }>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeController(write: ReturnType<typeof vi.fn>) {
  return {
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => [])
  }
}

function driveIdleTitle(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
  runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
}

function pointerCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(
    ([calledPtyId, data]) =>
      calledPtyId === ptyId && typeof data === 'string' && data.includes('orca orchestration check')
  )
}

function enterCalls(write: ReturnType<typeof vi.fn>, ptyId: string): unknown[][] {
  return write.mock.calls.filter(([calledPtyId, data]) => calledPtyId === ptyId && data === '\r')
}

describe('S10-21a C9: mail-on-restore honesty (design v3.2 §5(1))', () => {
  it('T16: a leafless pane not yet observed live this generation gets a withheld RECORD, not a silent delete', () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

      const ptyId = 'pty-restore-1'
      // Why NOT driveIdleTitle first: a restore seeds the pty record with
      // lastAgentStatusObservedLive: false (recordPtyWorktree's own default) — this is exactly
      // the "restored, not yet observed live this generation" state §5 describes.
      const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
      const handle = internals(runtime).issuePtyHandle(record)

      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db as never)
      db.insertMessage({ from: 'peer', to: handle, subject: 'queued_awaiting_pane check' })
      const row = db.getUndeliveredUnreadMessages(handle)[0]
      expect(row).toBeDefined()

      runtime.deliverPendingMessagesForHandle(handle)

      // Fails at base: the old code's final `else` unconditionally deleted the withheld entry,
      // so this assertion (and the queued_awaiting_pane snapshot below) failed there.
      expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
        'awaiting_idle_edge'
      )
      const snapshot = runtime.getMessageDeliverySnapshot({
        id: row.id,
        to_handle: handle,
        read: 0
      })
      expect(snapshot.delivery).toBe('queued_awaiting_pane')
      expect(write).not.toHaveBeenCalled()

      // Once observed live (the pane's first idle edge), the withheld record's job is done and
      // the message is delivered exactly once.
      driveIdleTitle(runtime, ptyId)
      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)

      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fence: repeated withheld attempts on a not-yet-observed-live pane never lose the record without delivering', () => {
    const runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    const ptyId = 'pty-restore-fence-1'
    const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, { connected: true })
    const handle = internals(runtime).issuePtyHandle(record)

    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db as never)
    db.insertMessage({ from: 'peer', to: handle, subject: 'fence check' })

    // Three withheld attempts in a row (e.g. three notifyMessageArrived pushes before the pane
    // is ever observed live) — the record must survive every one of them: never silently
    // deleted, and no Enter/pointer written (that would mean it "delivered" without the gate).
    for (let i = 0; i < 3; i += 1) {
      runtime.deliverPendingMessagesForHandle(handle)
      expect(internals(runtime).withheldDeliveryAttemptsByHandle.get(handle)?.reason).toBe(
        'awaiting_idle_edge'
      )
    }
    expect(write).not.toHaveBeenCalled()
    db.close()
  })
})

describe('S10-21a C9: notifyRebindDelivery arms delivery at a restore rebind (design v3.2 §5(2))', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => {
    db?.close()
  })

  it("T11 (delivery half): after a rebind, the rebound pane's waiting mail is delivered without a register call", () => {
    vi.useFakeTimers()
    try {
      db = new OrchestrationDb(':memory:')
      runtime = new OrcaRuntimeService()
      const write = vi.fn(() => true)
      runtime.setPtyController(makeController(write) as never)
      runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
      runtime.setOrchestrationDb(db as never)

      const paneKey = 'tabR:leaf-rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr'
      const created = db.upsertAgentByPaneSuffix({
        displayName: 'rebound-agent',
        role: null,
        hostId: 'local',
        paneKey,
        terminalHandle: 'term_pre_rebind',
        processIncarnation: 'inc1',
        worktreeId: null,
        worktreePath: null,
        branch: null,
        title: null,
        agentLabel: null,
        originHandle: 'term_pre_rebind',
        originHostId: 'local'
      })
      if (created.outcome === 'name_taken') {
        throw new Error('fixture setup failed')
      }
      const agentId = created.agent.id

      // The rebound pane itself: a live pty bound to the SAME pane_key the rebind just wrote —
      // mirrors rebindRestoredPane's step 2 UPDATE (agents.pane_key = newPaneKey). Already
      // observed live and idle, so `notifyRebindDelivery` should deliver synchronously, not
      // merely arm a withheld record.
      const ptyId = 'pty-rebound-1'
      const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
        connected: true,
        paneKey
      })
      internals(runtime).issuePtyHandle(record)
      driveIdleTitle(runtime, ptyId)

      // Waiting mail addressed to the identity's durable mailbox — arrived before the rebind
      // (e.g. queued while the pane was gone), exactly T11's "registered row + unread mail"
      // setup, minus the register call this test must never make.
      db.insertMessage({
        from: 'peer',
        to: `agent:${agentId}`,
        subject: 'waiting since before restart'
      })

      // Fails at base: `notifyRebindDelivery` does not exist there, so this call throws.
      runtime.notifyRebindDelivery(agentId)

      expect(pointerCalls(write, ptyId)).toHaveLength(1)
      vi.advanceTimersByTime(AGENT_PROMPT_SUBMIT_DELAY_MS)
      expect(enterCalls(write, ptyId)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifyRebindDelivery on a pane not yet observed live withholds honestly instead of throwing or dropping', () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    const write = vi.fn(() => true)
    runtime.setPtyController(makeController(write) as never)
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    runtime.setOrchestrationDb(db as never)

    const paneKey = 'tabS:leaf-ssssssss-ssss-4sss-8sss-ssssssssssss'
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'not-yet-live-agent',
      role: null,
      hostId: 'local',
      paneKey,
      terminalHandle: 'term_pre_rebind_2',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_pre_rebind_2',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const agentId = created.agent.id

    const ptyId = 'pty-rebound-2'
    const record = internals(runtime).recordPtyWorktree(ptyId, WORKTREE_ID, {
      connected: true,
      paneKey
    })
    internals(runtime).issuePtyHandle(record)
    // No driveIdleTitle — the rebound pane has not been observed live this generation yet.

    db.insertMessage({ from: 'peer', to: `agent:${agentId}`, subject: 'waiting, not yet live' })

    runtime.notifyRebindDelivery(agentId)

    expect(write).not.toHaveBeenCalled()
    // Keyed by the durable mailbox handle (agent:<id>) itself, not the resolved pty handle —
    // deliverPendingMessagesForHandle's recordWithheldDelivery calls always key on the caller's
    // own `handle` argument, never the ladder's internal `terminalHandle` resolution.
    expect(
      internals(runtime).withheldDeliveryAttemptsByHandle.get(`agent:${agentId}`)?.reason
    ).toBe('awaiting_idle_edge')
  })
})
