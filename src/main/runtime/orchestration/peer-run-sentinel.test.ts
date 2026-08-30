// S10-1 (A4, T6): PEER_RUN_ID is a sentinel mailbox Run seeded by migrate(), not a coordinator
// Run. Split into its own file to keep db.test.ts under the max-lines ratchet.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb, PEER_RUN_ID } from './db'

describe('PEER_RUN_ID sentinel', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('is seeded on every fresh database, legacy:0, and cannot be runUse-bound', () => {
    const d = createDb()
    expect(d.getRun(PEER_RUN_ID)).toMatchObject({ id: PEER_RUN_ID, legacy: 0 })

    expect(() =>
      d.bindRun({
        runId: PEER_RUN_ID,
        coordinatorHandle: 'term_a',
        coordinatorPaneKey: 'tab1:leaf1'
      })
    ).toThrow(/sentinel mailbox for peer agent mail/)
  })

  it('a message bound to PEER_RUN_ID is retrievable (the A4 fix requireRun depends on)', () => {
    const d = createDb()
    const msg = d.insertMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'peer mail',
      runId: PEER_RUN_ID
    })
    expect(d.getMessageById(msg.id)?.run_id).toBe(PEER_RUN_ID)
  })

  // Mutation proof: if the guard in bindRun were removed, PEER_RUN_ID would fall through to
  // the generic `run.legacy === 1` check — but the sentinel is legacy:0 precisely so
  // requireRun() (insertMessage) accepts it, so that generic check would NOT catch it and
  // bindRun would silently succeed in binding a peer-mail mailbox as a coordinator Run.
  it('MUTATION PROOF: the generic legacy===1 check alone would not refuse the sentinel', () => {
    const d = createDb()
    const raw = d.getRun(PEER_RUN_ID)
    expect(raw?.legacy).toBe(0) // if this were 1, the pre-existing generic check would suffice
    expect(() =>
      d.bindRun({
        runId: PEER_RUN_ID,
        coordinatorHandle: 'term_a',
        coordinatorPaneKey: 'tab1:leaf1'
      })
    ).toThrow()
  })
})
