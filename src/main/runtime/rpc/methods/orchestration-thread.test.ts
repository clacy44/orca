import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

function request(id: string, method: string, params: Record<string, unknown>): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}

function dispatcherFor(db: OrchestrationDb): RpcDispatcher {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  return new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
}

describe('orchestration.thread (BUG 4)', () => {
  let directory: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('replays every message on a thread, in order, after a runtime restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-replay-'))
    const dbPath = join(directory, 'orchestration.db')
    db = new OrchestrationDb(dbPath)

    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'one', threadId: 'thread_1' })
    db.insertMessage({ from: 'term_b', to: 'term_a', subject: 'two', threadId: 'thread_1' })
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'three', threadId: 'thread_1' })
    // A different thread must never leak into the replay.
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'unrelated', threadId: 'thread_2' })

    // Restart: close and reopen the same on-disk database.
    db.close()
    db = new OrchestrationDb(dbPath)
    const dispatcher = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-1', 'orchestration.thread', { id: 'thread_1' })
    )

    expect(response.ok).toBe(true)
    const result = (response as { result: { messages: { subject: string }[]; count: number } })
      .result
    expect(result.count).toBe(3)
    expect(result.messages.map((m) => m.subject)).toEqual(['one', 'two', 'three'])
  })

  it('filters to messages strictly after --since', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-since-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'one', threadId: 't1' })
    const second = db.insertMessage({
      from: 'term_b',
      to: 'term_a',
      subject: 'two',
      threadId: 't1'
    })
    const dispatcher = dispatcherFor(db)

    // Why a far-past/far-future bound and not the sibling message's own created_at: this store's
    // created_at has whole-second resolution (matches every other timestamp column here), so two
    // messages inserted in the same synchronous test can share one value — asserting against the
    // filter's boundary behavior, not inter-message timing, is what's actually under test.
    const beforeAll = await dispatcher.dispatch(
      request('thread-2a', 'orchestration.thread', { id: 't1', since: '2000-01-01T00:00:00Z' })
    )
    expect(
      (beforeAll as { result: { messages: { subject: string }[] } }).result.messages.map(
        (m) => m.subject
      )
    ).toEqual(['one', 'two'])

    const afterAll = await dispatcher.dispatch(
      request('thread-2b', 'orchestration.thread', { id: 't1', since: second.created_at })
    )
    expect((afterAll as { result: { messages: unknown[] } }).result.messages).toEqual([])
  })

  it('never returns a different thread’s messages', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-isolation-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'in-thread', threadId: 't1' })
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'other-thread', threadId: 't2' })
    const dispatcher = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-3', 'orchestration.thread', { id: 't1' })
    )

    const result = (response as { result: { messages: { subject: string }[] } }).result
    expect(result.messages.map((m) => m.subject)).toEqual(['in-thread'])
  })
})

describe('orchestration.inbox --thread-id (BUG 4)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('wins over --terminal and replays the whole thread', async () => {
    db = new OrchestrationDb(':memory:')
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'one', threadId: 't1' })
    db.insertMessage({ from: 'term_b', to: 'term_a', subject: 'two', threadId: 't1' })
    const dispatcher = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('inbox-1', 'orchestration.inbox', { terminal: 'term_a', threadId: 't1' })
    )

    const result = (response as { result: { messages: { subject: string }[]; count: number } })
      .result
    expect(result.count).toBe(2)
    expect(result.messages.map((m) => m.subject)).toEqual(['one', 'two'])
  })
})
