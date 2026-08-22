import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('getOrCreateRunDelivery pendingBehind', () => {
  let db: OrchestrationDb
  let runId: string
  let generation: number

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Starvation',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    runId = run.id
    generation = run.consumer_generation
  })

  afterEach(() => db.close())

  function sendToRun(subject: string) {
    return db.insertMessage({ runId, from: 'term_worker', to: `run:${runId}`, subject })
  }

  function readDelivery() {
    return db.getOrCreateRunDelivery({ runId, consumerGeneration: generation })
  }

  it('counts the messages stranded behind an outstanding Delivery', () => {
    sendToRun('first')
    const first = readDelivery()
    expect(first).toMatchObject({ replayed: false, pendingBehind: 0 })
    sendToRun('second')
    sendToRun('third')
    sendToRun('fourth')

    const replay = readDelivery()

    expect(replay).toMatchObject({ replayed: true, pendingBehind: 3 })
    expect(replay?.delivery.id).toBe(first?.delivery.id)
    expect(replay?.messages.map((message) => message.subject)).toEqual(['first'])
  })

  it('reports zero rather than a false alarm when nothing newer arrived', () => {
    sendToRun('only')
    readDelivery()

    expect(readDelivery()).toMatchObject({ replayed: true, pendingBehind: 0 })
  })

  it('starts a fresh Delivery with nothing behind it after an acknowledgement', () => {
    sendToRun('first')
    const first = readDelivery()
    sendToRun('second')
    db.acknowledgeRunDelivery({
      runId,
      consumerGeneration: generation,
      deliveryId: first!.delivery.id
    })

    const fresh = readDelivery()

    expect(fresh).toMatchObject({ replayed: false, pendingBehind: 0 })
    expect(fresh?.messages.map((message) => message.subject)).toEqual(['second'])
  })

  it('reports the remainder a capped fresh batch leaves behind', () => {
    for (let index = 0; index < 55; index += 1) {
      sendToRun(`message ${index}`)
    }

    const fresh = readDelivery()

    expect(fresh?.messages).toHaveLength(50)
    expect(fresh).toMatchObject({ replayed: false, pendingBehind: 5 })
  })

  it('still throws for a fenced consumer instead of reporting a count', () => {
    sendToRun('first')
    readDelivery()

    expect(() =>
      db.getOrCreateRunDelivery({ runId, consumerGeneration: generation + 1 })
    ).toThrowError(expect.objectContaining({ code: 'consumer_fenced' }))
  })

  it('returns nothing at all for an empty mailbox', () => {
    expect(readDelivery()).toBeUndefined()
  })
})
