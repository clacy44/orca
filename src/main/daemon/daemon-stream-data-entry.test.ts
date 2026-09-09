// R117 FIX 2: coalesce stops at 64KB per entry (mirrors session.ts:667's 64KB cap) so a sustained
// flood can't fuse the whole HELD_WRITE_THROUGH backlog into one string requiring a rope-flatten.
import { describe, expect, it } from 'vitest'
import { appendDaemonStreamData } from './daemon-stream-data-entry'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

function createBatch(): PendingStreamDataBatch {
  return {
    timer: null,
    queue: [],
    queuedChars: 0,
    queuedCharsBySession: new Map(),
    droppableQueuedSessionIds: new Set()
  }
}

describe('appendDaemonStreamData coalesce cap', () => {
  it('coalesces into the same entry below 64KB', () => {
    const batch = createBatch()
    appendDaemonStreamData(batch, 'session-1', 'a'.repeat(1000), {})
    appendDaemonStreamData(batch, 'session-1', 'b'.repeat(1000), {})

    expect(batch.queue).toHaveLength(1)
    expect(batch.queue[0]?.data.length).toBe(2000)
  })

  it('starts a new entry once the current one reaches 64KB, instead of growing it further', () => {
    const batch = createBatch()
    appendDaemonStreamData(batch, 'session-1', 'a'.repeat(64 * 1024), {})
    appendDaemonStreamData(batch, 'session-1', 'b'.repeat(10), {})

    expect(batch.queue).toHaveLength(2)
    expect(batch.queue[0]?.data.length).toBe(64 * 1024)
    expect(batch.queue[1]?.data).toBe('b'.repeat(10))
  })

  it('a large single append is not itself capped (the cap only stops further coalescing onto it)', () => {
    const batch = createBatch()
    appendDaemonStreamData(batch, 'session-1', 'a'.repeat(200 * 1024), {})
    appendDaemonStreamData(batch, 'session-1', 'b'.repeat(10), {})

    expect(batch.queue).toHaveLength(2)
    expect(batch.queue[0]?.data.length).toBe(200 * 1024)
  })

  it('still refuses to coalesce across a different session even below the cap', () => {
    const batch = createBatch()
    appendDaemonStreamData(batch, 'session-1', 'a'.repeat(10), {})
    appendDaemonStreamData(batch, 'session-2', 'b'.repeat(10), {})

    expect(batch.queue).toHaveLength(2)
  })
})
