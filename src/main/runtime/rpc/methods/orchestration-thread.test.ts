import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'

type Evidence = { terminalHandle: string; paneKey: string; launchToken: string }

function evidenceFor(handle: string): Evidence {
  return { terminalHandle: handle, paneKey: `pane_${handle}`, launchToken: `lt_${handle}` }
}

function request(
  id: string,
  method: string,
  params: Record<string, unknown>,
  evidence?: Evidence
): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params,
    ...(evidence ? { orchestrationCompatibilityEvidence: evidence } : {})
  }
}

// Why every attested handle "works" (no per-pane allow-list, unlike orchestration-agents.test.ts
// and orchestration-peer-ask-reply.test.ts): these tests exercise participant/degrade/sensitive
// behavior keyed on BARE terminal handles (thread_participants rows created directly by
// db.createThread, never via `agents register`) — there is no forged-identity scenario here to
// gate against, only "does resolveThreadReplay use the attested handle correctly".
function mockAttestation(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
    if (!evidence?.terminalHandle || !evidence.paneKey || !evidence.launchToken) {
      return null
    }
    const authority: OrchestrationCompatibilityCallerAuthority = {
      hostScope: { kind: 'local', hostId: 'local' },
      paneKey: evidence.paneKey,
      terminalHandle: evidence.terminalHandle,
      processIncarnation: 'proc-1',
      launchTokenHash: 'hash'
    }
    return authority
  })
}

function dispatcherFor(db: OrchestrationDb): {
  runtime: OrcaRuntimeService
  dispatcher: RpcDispatcher
} {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  mockAttestation(runtime)
  return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }) }
}

/** Mints a real threads/thread_participants row (bare-handle participants) and posts `subjects`
 * alternating from participants[0] -> participants[1] -> ... on that thread, mirroring how
 * `db.createThread` + `bumpThreadOnMessage` are used together elsewhere in this series. */
function seedParticipantThread(
  db: OrchestrationDb,
  participants: [string, string],
  subjects: readonly string[]
): string {
  const { thread } = db.createThread({
    subject: 'test thread',
    createdByAgentId: null,
    participants: participants.map((handle) => ({ participantKey: handle, handle }))
  })
  let sequence: number | undefined
  subjects.forEach((subject, i) => {
    const from = participants[i % 2]
    const to = participants[(i + 1) % 2]
    const message = db.insertMessage({ from, to, subject, threadId: thread.id })
    db.bumpThreadOnMessage(thread.id, message)
    sequence = message.sequence
  })
  void sequence
  return thread.id
}

describe('orchestration.thread (BUG 4, hardened per S10-2 ruling 1)', () => {
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

  it('a full participant replays every message on a thread, in order, after a runtime restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-replay-'))
    const dbPath = join(directory, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two', 'three'])
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'unrelated', threadId: 'thread_2' })

    // Restart: close and reopen the same on-disk database.
    db.close()
    db = new OrchestrationDb(dbPath)
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-1', 'orchestration.thread', { id: threadId }, evidenceFor('term_a'))
    )

    expect(response.ok).toBe(true)
    const result = (
      response as {
        result: { messages: { subject: string }[]; count: number; degraded: boolean }
      }
    ).result
    expect(result.degraded).toBe(false)
    expect(result.count).toBe(3)
    expect(result.messages.map((m) => m.subject)).toEqual(['one', 'two', 'three'])
  })

  it('filters to messages strictly after --since (a sequence cursor)', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-since-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const { dispatcher } = dispatcherFor(db)

    const beforeAll = await dispatcher.dispatch(
      request(
        'thread-2a',
        'orchestration.thread',
        { id: threadId, since: '0' },
        evidenceFor('term_a')
      )
    )
    expect(
      (beforeAll as { result: { messages: { subject: string }[] } }).result.messages.map(
        (m) => m.subject
      )
    ).toEqual(['one', 'two'])

    const secondSeq = db.getThreadMessages(threadId).at(-1)?.sequence
    const afterAll = await dispatcher.dispatch(
      request(
        'thread-2b',
        'orchestration.thread',
        { id: threadId, since: String(secondSeq) },
        evidenceFor('term_a')
      )
    )
    expect((afterAll as { result: { messages: unknown[] } }).result.messages).toEqual([])
  })

  // MUTATION PROOF (adversarial review, remote-wire-compatibility): a pre-S10-1 client/host
  // resumes with the ISO `created_at` cursor it printed itself. If `--since` reverted to
  // sequence-only parsing, this call would throw `invalid_argument` instead of replaying —
  // exactly the old<->new break the review found.
  it('also accepts an ISO timestamp --since cursor (pre-migration wire compatibility)', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-since-timestamp-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const { dispatcher } = dispatcherFor(db)

    const past = await dispatcher.dispatch(
      request(
        'thread-ts-past',
        'orchestration.thread',
        { id: threadId, since: '2000-01-01T00:00:00Z' },
        evidenceFor('term_a')
      )
    )
    expect(past.ok).toBe(true)
    expect(
      (past as { result: { messages: { subject: string }[] } }).result.messages.map(
        (m) => m.subject
      )
    ).toEqual(['one', 'two'])

    const future = await dispatcher.dispatch(
      request(
        'thread-ts-future',
        'orchestration.thread',
        { id: threadId, since: '2099-01-01T00:00:00Z' },
        evidenceFor('term_a')
      )
    )
    expect(future.ok).toBe(true)
    expect((future as { result: { messages: unknown[] } }).result.messages).toEqual([])
  })

  it('never returns a different thread’s messages', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-isolation-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['in-thread'])
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'other-thread', threadId: 't2' })
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-3', 'orchestration.thread', { id: threadId }, evidenceFor('term_a'))
    )

    const result = (response as { result: { messages: { subject: string }[] } }).result
    expect(result.messages.map((m) => m.subject)).toEqual(['in-thread'])
  })

  // S10-9 R4: a thread replay is where a sender checks on mail they sent — their own messages
  // carry the same honest `delivery` state `orchestration sent` reports, so a message stuck
  // behind a withheld pointer-delivery gate never reads the same as one nobody has pushed yet.
  // Scoped to the caller's own messages only — delivery state is sender-side information.
  it('annotates the caller’s own messages with delivery state, never the other participant’s', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-thread-delivery-honesty-'))
    db = new OrchestrationDb(join(directory, 'orchestration.db'))
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['from a', 'from b'])
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-delivery', 'orchestration.thread', { id: threadId }, evidenceFor('term_a'))
    )

    expect(response.ok).toBe(true)
    const messages = (
      response as { result: { messages: { subject: string; delivery?: string }[] } }
    ).result.messages
    const mine = messages.find((m) => m.subject === 'from a')
    const theirs = messages.find((m) => m.subject === 'from b')
    expect(mine?.delivery).toBe('queued')
    expect(theirs?.delivery).toBeUndefined()
  })

  // T1 (s10-2-spec.md acceptance table): a caller who does NOT participate in a thread gets a
  // recipient-filtered replay, never the other participants' conversation. Mutation this kills:
  // restoring orchestration-thread.ts's old unguarded `db.getThreadMessages(params.id)` call
  // (dropping resolveThreadReplay's participant check) — this test would then see BOTH
  // messages, not zero.
  it('T1: a non-participant on a non-sensitive thread degrades to a recipient-filtered replay, never the full conversation', async () => {
    db = new OrchestrationDb(':memory:')
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['secret plan', 'reply'])
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-outsider', 'orchestration.thread', { id: threadId }, evidenceFor('term_c'))
    )
    expect(response.ok).toBe(true)
    const result = (response as { result: { messages: unknown[]; degraded: boolean } }).result
    expect(result.degraded).toBe(true)
    expect(result.messages).toEqual([])
  })

  it('T1: a non-participant addressed on a raw (non-thread-directory) thread id sees only their own recipient view', async () => {
    db = new OrchestrationDb(':memory:')
    // No db.createThread call: this thread id has no `threads` row at all — the shape a raw
    // pre-thread-directory insertMessage call produces.
    db.insertMessage({ from: 'term_a', to: 'term_b', subject: 'one', threadId: 'legacy_t1' })
    db.insertMessage({ from: 'term_b', to: 'term_a', subject: 'two', threadId: 'legacy_t1' })
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-legacy', 'orchestration.thread', { id: 'legacy_t1' }, evidenceFor('term_b'))
    )
    const result = (response as { result: { messages: { subject: string }[]; degraded: boolean } })
      .result
    expect(result.degraded).toBe(true)
    // term_b is the `to_handle` of exactly one of the two messages.
    expect(result.messages.map((m) => m.subject)).toEqual(['one'])
  })

  it('an unattested caller (no evidence at all) gets nothing, never the unfiltered dump', async () => {
    db = new OrchestrationDb(':memory:')
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-anon', 'orchestration.thread', { id: threadId })
    )
    const result = (response as { result: { messages: unknown[]; degraded: boolean } }).result
    expect(result.degraded).toBe(true)
    expect(result.messages).toEqual([])
  })

  // T1's other half: sensitive threads refuse a non-participant outright rather than degrading
  // (ruling 8's one exception, s10-2-spec.md:110/179).
  it('T1: a non-participant is refused not_a_participant on a sensitive thread — no bodies, no degrade', async () => {
    db = new OrchestrationDb(':memory:')
    const { thread } = db.createThread({
      subject: 'sensitive matter',
      createdByAgentId: null,
      sensitive: true,
      participants: [
        { participantKey: 'term_a', handle: 'term_a' },
        { participantKey: 'term_b', handle: 'term_b' }
      ]
    })
    const message = db.insertMessage({
      from: 'term_a',
      to: 'term_b',
      subject: 'do not leak',
      threadId: thread.id
    })
    db.bumpThreadOnMessage(thread.id, message)
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-sensitive', 'orchestration.thread', { id: thread.id }, evidenceFor('term_c'))
    )
    expect(response.ok).toBe(false)
    expect((response as { error: { code: string } }).error.code).toBe('not_a_participant')
  })

  it('a participant on a sensitive thread still gets the full replay', async () => {
    db = new OrchestrationDb(':memory:')
    const { thread } = db.createThread({
      subject: 'sensitive matter',
      createdByAgentId: null,
      sensitive: true,
      participants: [
        { participantKey: 'term_a', handle: 'term_a' },
        { participantKey: 'term_b', handle: 'term_b' }
      ]
    })
    const message = db.insertMessage({
      from: 'term_a',
      to: 'term_b',
      subject: 'sensitive body',
      threadId: thread.id
    })
    db.bumpThreadOnMessage(thread.id, message)
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request(
        'thread-sensitive-ok',
        'orchestration.thread',
        { id: thread.id },
        evidenceFor('term_b')
      )
    )
    expect(response.ok).toBe(true)
    const result = (response as { result: { messages: { subject: string }[] } }).result
    expect(result.messages.map((m) => m.subject)).toEqual(['sensitive body'])
  })

  // Adversarial review S10-2b major #5: `omitted` was declared but never populated.
  it('reports omitted.purged for a full participant', async () => {
    db = new OrchestrationDb(':memory:')
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const toPurge = db.getThreadMessages(threadId).find((m) => m.subject === 'one')!
    db.purgeMessage({ messageId: toPurge.id, reason: 'oops', purgedByAgentId: null })
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-omit-1', 'orchestration.thread', { id: threadId }, evidenceFor('term_a'))
    )

    const result = (
      response as {
        result: {
          messages: { subject: string }[]
          omitted?: { purged: number; withheld: number }
        }
      }
    ).result
    expect(result.messages.map((m) => m.subject)).toEqual(['two'])
    expect(result.omitted).toEqual({ purged: 1, withheld: 0 })
  })

  it('reports omitted.purged on the recipient-filtered degrade path too', async () => {
    db = new OrchestrationDb(':memory:')
    const { thread } = db.createThread({
      subject: 'test',
      createdByAgentId: null,
      participants: [{ participantKey: 'term_a', handle: 'term_a' }]
    })
    // term_c is not a participant, but IS a recipient on this thread — the degrade path
    // (getThreadMessagesFor) filters by to_handle, not participant rows.
    const toPurge = db.insertMessage({
      from: 'term_a',
      to: 'term_c',
      subject: 'one',
      threadId: thread.id
    })
    db.bumpThreadOnMessage(thread.id, toPurge)
    db.purgeMessage({ messageId: toPurge.id, reason: 'oops', purgedByAgentId: null })
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request('thread-omit-2', 'orchestration.thread', { id: thread.id }, evidenceFor('term_c'))
    )

    const result = (
      response as { result: { degraded: boolean; omitted?: { purged: number; withheld: number } } }
    ).result
    expect(result.degraded).toBe(true)
    expect(result.omitted).toEqual({ purged: 1, withheld: 0 })
  })
})

describe('orchestration.inbox --thread-id (BUG 4, hardened)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('wins over --terminal and replays the whole thread for a participant', async () => {
    db = new OrchestrationDb(':memory:')
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request(
        'inbox-1',
        'orchestration.inbox',
        { terminal: 'term_a', threadId },
        evidenceFor('term_a')
      )
    )

    const result = (response as { result: { messages: { subject: string }[]; count: number } })
      .result
    expect(result.count).toBe(2)
    expect(result.messages.map((m) => m.subject)).toEqual(['one', 'two'])
  })

  it('a non-participant querying --thread-id gets the same recipient-filtered degrade as orchestration.thread', async () => {
    db = new OrchestrationDb(':memory:')
    const threadId = seedParticipantThread(db, ['term_a', 'term_b'], ['one', 'two'])
    const { dispatcher } = dispatcherFor(db)

    const response = await dispatcher.dispatch(
      request(
        'inbox-2',
        'orchestration.inbox',
        { terminal: 'term_a', threadId },
        evidenceFor('term_c')
      )
    )
    const result = (response as { result: { messages: unknown[]; degraded: boolean } }).result
    expect(result.degraded).toBe(true)
    expect(result.messages).toEqual([])
  })
})
