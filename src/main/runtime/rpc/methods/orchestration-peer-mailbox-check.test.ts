// Series 3: peer mail durability generalized past the agent:<id> mailbox. A4/BUG 6 originally
// shipped a sentinel-Run + durable-delivery fix scoped to `agent:<id>` sends only (S10-1d); this
// covers the SAME fix for a genuinely bare terminal-handle peer send (two hand-started agents,
// neither registered) and the ackMode dual-behaviour switch on the dispatch:/bare-handle
// mailboxes (owner decision 3).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../shared/orchestration-rpc-contract'

describe('bare-handle peer mail (A4/BUG 6, generalized past agent:<id>)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const ctx: RpcContext = {} as RpcContext

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // Why null: these two peers are hand-started and unregistered — no attested pane, no
    // agents row for either handle. That is exactly the scenario A4/BUG 6 describes and the one
    // the agent:<id>-only S10-1d fix left unaddressed.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime
  }

  afterEach(() => {
    db?.close()
  })

  it('a bare-handle send with no bound Run lands on PEER_RUN_ID; recipient check returns it, no throw', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: 'term_c',
      subject: 'hand-started peer mail'
    })
    const stored = db.getUnreadMessages('term_c')[0]
    expect(stored?.run_id).toBe(PEER_RUN_ID)

    const checked = (await call('orchestration.check', { terminal: 'term_c' })) as {
      messages: { subject: string }[]
      legacyPending: number
    }
    expect(checked.messages.map((m) => m.subject)).toEqual(['hand-started peer mail'])
    expect(checked.legacyPending).toBe(0)

    // Destructive default (ackMode absent): consumed immediately, same as before this fix.
    const second = (await call('orchestration.check', { terminal: 'term_c' })) as {
      messages: unknown[]
    }
    expect(second.messages).toEqual([])
  })

  // MUTATION PROOF: reinstating the removed `throw new OrchestrationError('legacy_read_only', …)`
  // in the bare-handle branch's consuming path fails this test even though it never touches the
  // agent:<id> mailbox T2 originally covered.
  it('MUTATION PROOF: the peer branch never throws legacy_read_only, even sharing a mailbox with genuine legacy debt', async () => {
    setup()
    db.insertMessage({
      from: 'term_x',
      to: 'term_c',
      subject: 'genuine legacy debt',
      runId: ORCHESTRATION_LEGACY_RUN_ID
    })
    await call('orchestration.send', { from: 'term_a', to: 'term_c', subject: 'fresh peer mail' })

    const checked = (await call('orchestration.check', { terminal: 'term_c' })) as {
      messages: { subject: string }[]
      legacyPending: number
    }
    expect(checked.legacyPending).toBe(1)
    expect(checked.messages.map((m) => m.subject)).toEqual(['fresh peer mail'])
    const legacyRow = db
      .getAllMessagesForHandle('term_c')
      .find((m) => m.subject === 'genuine legacy debt')
    expect(legacyRow?.read).toBe(0)
  })

  it('a bare-handle mailbox with ONLY legacy debt reports it and never throws', async () => {
    setup()
    db.insertMessage({
      from: 'term_x',
      to: 'term_c',
      subject: 'legacy only',
      runId: ORCHESTRATION_LEGACY_RUN_ID
    })
    const checked = (await call('orchestration.check', { terminal: 'term_c' })) as {
      messages: unknown[]
      legacyPending: number
    }
    expect(checked.messages).toEqual([])
    expect(checked.legacyPending).toBe(1)
  })

  it('ackMode:"implicit" opts a bare-handle mailbox into replay-until-ack durability (dual behaviour)', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: 'term_c',
      subject: 'durable peer mail'
    })

    const first = (await call('orchestration.check', {
      terminal: 'term_c',
      ackMode: 'implicit'
    })) as { deliveryId: string; messages: { subject: string }[]; replayed: boolean }
    expect(first.messages.map((m) => m.subject)).toEqual(['durable peer mail'])
    expect(first.replayed).toBe(false)

    // MUTATION PROOF (D1): kill the client mid-check — a re-check without --ack replays the
    // identical batch and deliveryId; any ack keyed on host-side state alone (or a fresh
    // markAsRead-on-read) would fail this.
    const second = (await call('orchestration.check', {
      terminal: 'term_c',
      ackMode: 'implicit'
    })) as { deliveryId: string; messages: unknown[]; replayed: boolean }
    expect(second.deliveryId).toBe(first.deliveryId)
    expect(second.messages).toEqual(first.messages)
    expect(second.replayed).toBe(true)

    // MUTATION PROOF (B2/D4): no read path stamps delivered_at — it stays the ambient-push
    // watermark. Writing it here would turn this assertion (and the ambient-push restart-repoint
    // path, orca-runtime.ts) red.
    const beforeAck = db.getAllMessagesForHandle('term_c')[0]
    expect(beforeAck?.delivered_at).toBeNull()

    // MUTATION PROOF (D2): --ack clears it; the next check returns empty.
    const acked = (await call('orchestration.check', {
      terminal: 'term_c',
      ackMode: 'implicit',
      ack: first.deliveryId
    })) as { messages: unknown[]; pendingBehind: number }
    expect(acked.messages).toHaveLength(0)
    expect(acked.pendingBehind).toBe(0)
    const afterAck = db.getAllMessagesForHandle('term_c')[0]
    expect(afterAck?.read).toBe(1)
    expect(afterAck?.delivered_at).toBeNull()
  })

  it('without ackMode the dispatch:/bare-handle default stays destructive (zero regression)', async () => {
    setup()
    await call('orchestration.send', {
      from: 'term_a',
      to: 'term_c',
      subject: 'default destructive'
    })
    const checked = (await call('orchestration.check', { terminal: 'term_c' })) as {
      deliveryId?: string
      messages: unknown[]
    }
    expect(checked.deliveryId).toBeUndefined()
    const stored = db.getAllMessagesForHandle('term_c')[0]
    expect(stored?.read).toBe(1)
  })
})

describe('dispatch: mailbox ackMode dual behaviour', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const ctx: RpcContext = {} as RpcContext

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  afterEach(() => {
    db?.close()
  })

  it('ackMode:"implicit" opts a dispatch: mailbox into replay-until-ack durability without regressing the default', async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime
    const run = db.createRun({
      objective: 'implicit-ack dispatch mailbox',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'implicit-ack dispatch mailbox', runId: run.id })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'coordinator note',
      runId: run.id
    })

    const first = (await call('orchestration.check', {
      terminal: 'term_worker',
      ackMode: 'implicit'
    })) as { deliveryId: string; messages: { subject: string }[]; replayed: boolean }
    expect(first.messages.map((m) => m.subject)).toEqual(['coordinator note'])
    expect(first.replayed).toBe(false)

    // MUTATION PROOF: replays identically until acked (same as the bare-handle/agent: cases).
    const second = (await call('orchestration.check', {
      terminal: 'term_worker',
      ackMode: 'implicit'
    })) as { deliveryId: string; replayed: boolean }
    expect(second.deliveryId).toBe(first.deliveryId)
    expect(second.replayed).toBe(true)
    expect(db.getAllMessagesForHandle(`dispatch:${dispatch.id}`)[0]?.delivered_at).toBeNull()

    const acked = (await call('orchestration.check', {
      terminal: 'term_worker',
      ackMode: 'implicit',
      ack: first.deliveryId
    })) as { messages: unknown[] }
    expect(acked.messages).toHaveLength(0)
  })

  it('the default (no ackMode) stays destructive for the dispatch: mailbox', async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime
    const run = db.createRun({
      objective: 'destructive default dispatch mailbox',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'destructive default dispatch mailbox', runId: run.id })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'coordinator note',
      runId: run.id
    })

    const checked = (await call('orchestration.check', { terminal: 'term_worker' })) as {
      deliveryId?: string
      messages: { subject: string }[]
    }
    expect(checked.deliveryId).toBeUndefined()
    expect(checked.messages.map((m) => m.subject)).toEqual(['coordinator note'])
    const second = (await call('orchestration.check', { terminal: 'term_worker' })) as {
      messages: unknown[]
    }
    expect(second.messages).toEqual([])
  })
})
