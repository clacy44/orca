// S10-2b deferral: sensitive-thread refusals at the broadcast/federation edges.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import {
  assertThreadNotSensitiveForBroadcast,
  assertThreadNotSensitiveForFederation
} from './orchestration-sensitive-thread-guard'

describe('sensitive-thread edge guards', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('is a no-op with no threadId at all', () => {
    const d = freshDb()
    expect(() => assertThreadNotSensitiveForBroadcast(d, undefined)).not.toThrow()
    expect(() => assertThreadNotSensitiveForFederation(d, null)).not.toThrow()
  })

  it('is a no-op for a non-sensitive thread', () => {
    const d = freshDb()
    const { thread } = d.createThread({ subject: 's', createdByAgentId: null, participants: [] })
    expect(() => assertThreadNotSensitiveForBroadcast(d, thread.id)).not.toThrow()
    expect(() => assertThreadNotSensitiveForFederation(d, thread.id)).not.toThrow()
  })

  it('refuses sensitive_thread_no_broadcast for a sensitive thread', () => {
    const d = freshDb()
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: null,
      sensitive: true,
      participants: []
    })
    expect(() => assertThreadNotSensitiveForBroadcast(d, thread.id)).toThrow(
      /sensitive thread.*broadcast/
    )
  })

  it('refuses sensitive_thread_no_federation for a sensitive thread', () => {
    const d = freshDb()
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: null,
      sensitive: true,
      participants: []
    })
    expect(() => assertThreadNotSensitiveForFederation(d, thread.id)).toThrow(
      /sensitive thread.*federation/
    )
  })
})
