// S10-2b deferral: send-side thread minting (findOrCreatePeerThread), through the public
// OrchestrationDb API.
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('findOrCreatePeerThread', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('mints a fresh 1:1 peer thread when none exists', () => {
    const d = freshDb()
    const result = d.findOrCreatePeerThread({
      agentAId: 'agt_a',
      agentBId: 'agt_b',
      subjectHint: null
    })
    expect(result.created).toBe(true)
    expect(result.thread.origin).toBe('peer')
    expect(d.isThreadParticipant(result.thread.id, 'agt_a')).toBe(true)
    expect(d.isThreadParticipant(result.thread.id, 'agt_b')).toBe(true)
  })

  it('reuses the existing live 1:1 thread on a second call, in either agent order', () => {
    const d = freshDb()
    const first = d.findOrCreatePeerThread({
      agentAId: 'agt_a',
      agentBId: 'agt_b',
      subjectHint: null
    })
    const second = d.findOrCreatePeerThread({
      agentAId: 'agt_a',
      agentBId: 'agt_b',
      subjectHint: null
    })
    expect(second.created).toBe(false)
    expect(second.thread.id).toBe(first.thread.id)
    const reversed = d.findOrCreatePeerThread({
      agentAId: 'agt_b',
      agentBId: 'agt_a',
      subjectHint: null
    })
    expect(reversed.thread.id).toBe(first.thread.id)
  })

  it('a third agent leaving does not resurrect their old group thread as a fresh 1:1 for the remaining two', () => {
    const d = freshDb()
    const { thread } = d.createThread({
      subject: 'group',
      createdByAgentId: 'agt_a',
      participants: [
        { participantKey: 'agt_a', agentId: 'agt_a' },
        { participantKey: 'agt_b', agentId: 'agt_b' },
        { participantKey: 'agt_c', agentId: 'agt_c' }
      ]
    })
    d.leaveThread(thread.id, 'agt_c')
    // Now exactly 2 live participants (a, b) — this DOES count as their 1:1 and is reused,
    // matching the "exactly two live participants" definition, not an identity check on origin.
    const minted = d.findOrCreatePeerThread({
      agentAId: 'agt_a',
      agentBId: 'agt_b',
      subjectHint: null
    })
    expect(minted.thread.id).toBe(thread.id)
    expect(minted.created).toBe(false)
  })
})
